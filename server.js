require("dotenv").config();
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const crypto = require("crypto");
const QRCode = require("qrcode");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-in-env";
const MAX_TICKETS = 400;

// --- DUAL BREVO ACCOUNT SETUP ---
// Two Brevo accounts = 600 emails/day combined (300 each)
// Code automatically falls back to account 2 when account 1 hits its limit
const BREVO_ACCOUNTS = [
  {
    name: "primary",
    apiKey: process.env.BREVO_API_KEY_1,
    senderEmail: process.env.SENDER_EMAIL_1,
    senderName: process.env.SENDER_NAME_1 || "Orkhon School Movie Night",
    sentToday: 0,
    dailyLimit: 290, // a bit under 300 to leave buffer
    blockedUntil: 0, // timestamp; if Brevo says "limit reached", we skip until next day
  },
  {
    name: "backup",
    apiKey: process.env.BREVO_API_KEY_2,
    senderEmail: process.env.SENDER_EMAIL_2,
    senderName: process.env.SENDER_NAME_2 || "Orkhon School Movie Night",
    sentToday: 0,
    dailyLimit: 290,
    blockedUntil: 0,
  },
];

// Reset daily counters at midnight UTC (Brevo's reset time)
let lastResetDay = new Date().getUTCDate();
function maybeResetCounters() {
  const today = new Date().getUTCDate();
  if (today !== lastResetDay) {
    BREVO_ACCOUNTS.forEach((a) => {
      a.sentToday = 0;
      a.blockedUntil = 0;
    });
    lastResetDay = today;
    console.log("🔄 Daily email counters reset");
  }
}

const poster_link =
  "https://cdn11.bigcommerce.com/s-ydriczk/images/stencil/1500x1500/products/89058/93685/Joker-2019-Final-Style-steps-Poster-buy-original-movie-posters-at-starstills__62518.1669120603.jpg?c=2&imbypass=on";

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

let ticketCount = 0;
const claimedEmails = new Set();
const activeTickets = new Map();

// --- BREVO EMAIL (HTTP API) ---
function pickAccount() {
  maybeResetCounters();
  const now = Date.now();
  // Try accounts in order; pick first one that has capacity and isn't blocked
  for (const account of BREVO_ACCOUNTS) {
    if (!account.apiKey) continue; // skip unconfigured
    if (now < account.blockedUntil) continue;
    if (account.sentToday >= account.dailyLimit) continue;
    return account;
  }
  return null; // all accounts exhausted
}

async function sendEmailViaBrevo({ to, subject, htmlContent, qrBase64 }) {
  const account = pickAccount();
  if (!account) {
    throw new Error("All Brevo accounts at daily limit");
  }

  const body = {
    sender: { email: account.senderEmail, name: account.senderName },
    to: [{ email: to }],
    subject,
    htmlContent,
  };
  if (qrBase64) {
    body.attachment = [{ name: "qrcode.png", content: qrBase64 }];
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": account.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();

    // If Brevo says we hit the daily limit, mark this account blocked until tomorrow
    if (
      response.status === 402 ||
      response.status === 429 ||
      /limit/i.test(errText) ||
      /quota/i.test(errText)
    ) {
      // block until next UTC midnight
      const now = new Date();
      const tomorrow = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + 1,
          0,
          5,
        ),
      );
      account.blockedUntil = tomorrow.getTime();
      console.warn(
        `⚠️ Brevo account "${account.name}" hit limit. Blocked until ${tomorrow.toISOString()}`,
      );
      // Retry once with a different account
      return sendEmailViaBrevo({ to, subject, htmlContent, qrBase64 });
    }

    throw new Error(`Brevo ${response.status} (${account.name}): ${errText}`);
  }

  account.sentToday++;
  return { account: account.name, ...(await response.json()) };
}

const emailQueue = [];
let emailWorkerRunning = false;
async function processEmailQueue() {
  if (emailWorkerRunning) return;
  emailWorkerRunning = true;
  while (emailQueue.length > 0) {
    const job = emailQueue.shift();
    try {
      const result = await sendEmailViaBrevo(job);
      console.log(`📧 Email sent to ${job.to} via ${result.account}`);
    } catch (err) {
      console.error("Email send error:", err.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  emailWorkerRunning = false;
}

// --- GOOGLE SHEETS ---
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : "",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(
  process.env.GOOGLE_SHEET_ID,
  serviceAccountAuth,
);
let sheet;

const sheetQueue = [];
let sheetWorkerRunning = false;
async function processSheetQueue() {
  if (sheetWorkerRunning) return;
  sheetWorkerRunning = true;
  while (sheetQueue.length > 0) {
    const job = sheetQueue.shift();
    try {
      await job();
    } catch (err) {
      console.error("Sheet job error:", err.message);
    }
  }
  sheetWorkerRunning = false;
}
function enqueueSheetJob(fn) {
  sheetQueue.push(fn);
  processSheetQueue();
}

async function initializeData() {
  await doc.loadInfo();
  sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  ticketCount = rows.length;
  rows.forEach((row, idx) => {
    const email = row.get("И-мэйл");
    const id = row.get("ID");
    const status = row.get("Ирц");
    const num = parseInt(row.get("Дугаар"), 10) || idx + 1;
    if (email) claimedEmails.add(email);
    if (id) {
      activeTickets.set(id, {
        email,
        studentClass: row.get("Анги"),
        ticketNumber: num,
        present: status === "Ирсэн",
        rowNumber: row.rowNumber,
      });
    }
  });
  console.log(`✅ Loaded ${ticketCount} existing tickets from Google Sheets.`);
}

const generateHTML = (content) => `
<!DOCTYPE html>
<html lang="mn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>Киноны тасалбар</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #F9FAFB; color: #111827; margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; box-sizing: border-box; }
        .card { background: #FFFFFF; width: 100%; max-width: 380px; padding: 40px 30px; border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.06); text-align: center; box-sizing: border-box; }
        h1 { font-size: 22px; font-weight: 700; margin: 0 0 8px 0; }
        p { color: #6B7280; font-size: 15px; margin: 0 0 24px 0; line-height: 1.5; }
        .emoji-header { font-size: 42px; margin-bottom: 16px; display: block; }
        input { width: 100%; padding: 16px; margin-bottom: 16px; border: 1px solid #E5E7EB; border-radius: 14px; font-size: 15px; box-sizing: border-box; background-color: #F9FAFB; }
        input:focus { outline: none; border-color: #6366F1; background-color: #FFFFFF; box-shadow: 0 0 0 4px rgba(99,102,241,0.15); }
        button { width: 100%; padding: 16px; background-color: #111827; color: white; border: none; border-radius: 14px; font-size: 16px; font-weight: 600; cursor: pointer; }
        .ticket-number { font-size: 48px; font-weight: 700; color: #111827; margin: 16px 0; }
        .email-display { background: #F3F4F6; padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 600; color: #4B5563; word-break: break-all; margin-bottom: 20px;}
        .alert-error { color: #DC2626; }
        .poster-img { width: 100%; border-radius: 14px; margin-top: 20px; object-fit: cover; }
        .footer-text { margin-top: 30px; font-size: 13px; color: #9CA3AF; font-weight: 600; }
    </style>
</head>
<body>
    <div class="card">${content}<div class="footer-text">Developed by 12A Tengis</div></div>
</body>
</html>
`;

// --- RATE LIMITS ---
// Per-IP: high enough that shared school WiFi isn't blocked
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // 100 submits per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.",
});

// Per-email: prevents one student from spamming the form
const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // 5 attempts per email per minute (handles typos/retries)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body?.studentEmail || "").trim().toLowerCase();
    return email || req.ip;
  },
  message: "И-мэйл хаягаасаа хэт олон хүсэлт. Түр хүлээнэ үү.",
});

// --- ROUTES ---
app.get("/", (req, res) => res.redirect("/scan"));

app.get("/scan", (req, res) => {
  if (ticketCount >= MAX_TICKETS) {
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🛑</span><h1 class="alert-error">Уучлаарай, дууссан!</h1><p>Нийт ${MAX_TICKETS} тасалбар дууссан байна.</p>`,
        ),
      );
  }
  const currentDateTime = new Date().toLocaleString("mn-MN", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  res.send(
    generateHTML(`
        <span class="emoji-header">
            <img src="/width_550.webp" style="width: 100px;" alt="Logo">
        </span>
        <h1>Orkhon Khasu Movie Night</h1>
        <p style="font-weight: 600; color: #4B5563; margin-top: -5px; margin-bottom: 15px;">📅 ${currentDateTime}</p>
        <p>Мэдээллээ оруулан тасалбар болон QR кодоо аваарай.</p>
        <form action="/scan" method="POST" style="margin-top: 24px;">
            <input type="email" name="studentEmail" placeholder="ner.ovog@orkhonschool.edu.mn" required>
            <input type="text" name="studentClass" placeholder="Анги: (Жишээ нь: 10A)" required>
            <button type="submit">Тасалбар авах</button>
            <p style="margin-top: 16px; font-size: 14px; font-weight: 600; color: #059669;">
                🎟️ Үлдсэн тасалбар: ${MAX_TICKETS - ticketCount}
            </p>
        </form>
        <img src="${poster_link}" alt="Poster" class="poster-img">
    `),
  );
});

app.post("/scan", ipLimiter, emailLimiter, async (req, res) => {
  const email = (req.body.studentEmail || "").trim().toLowerCase();
  const studentClass = (req.body.studentClass || "").trim();

  if (!email || !studentClass) {
    return res.send(
      generateHTML(
        `<span class="emoji-header">⚠️</span><h1 class="alert-error">Дутуу мэдээлэл</h1><p>И-мэйл болон ангиа бөглөнө үү.</p>`,
      ),
    );
  }
  if (!email.endsWith("@orkhonschool.edu.mn")) {
    return res.send(
      generateHTML(
        `<span class="emoji-header">⚠️</span><h1 class="alert-error">Буруу хаяг</h1><p>Зөвхөн сургуулийн и-мэйл хаяг ашиглана уу.</p>`,
      ),
    );
  }
  if (claimedEmails.has(email)) {
    return res.send(
      generateHTML(
        `<span class="emoji-header">🎟️</span><h1 style="color: #059669;">Баталгаажсан байна!</h1><p>И-мэйл хаягаа шалгана уу.</p>`,
      ),
    );
  }

  const myTicketNumber = ++ticketCount;
  if (myTicketNumber > MAX_TICKETS) {
    ticketCount--;
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🛑</span><h1 class="alert-error">Уучлаарай, дууссан!</h1>`,
        ),
      );
  }
  claimedEmails.add(email);

  const ticketId = crypto.randomBytes(6).toString("hex");
  activeTickets.set(ticketId, {
    email,
    studentClass,
    ticketNumber: myTicketNumber,
    present: false,
    rowNumber: null,
  });

  let qrCodeDataURI;
  try {
    qrCodeDataURI = await QRCode.toDataURL(ticketId);
  } catch (err) {
    console.error("QR generation error:", err);
    ticketCount--;
    claimedEmails.delete(email);
    activeTickets.delete(ticketId);
    return res.send(
      generateHTML(
        `<span class="emoji-header">⚠️</span><h1 class="alert-error">Алдаа гарлаа</h1><p>Дахин оролдоно уу.</p>`,
      ),
    );
  }

  res.send(
    generateHTML(`
        <span class="emoji-header">🎉</span><h1>Амжилттай!</h1>
        <p>И-мэйл рүү тань QR код илгээгдлээ. Хаалган дээр уншуулж орно уу.</p>
        <div class="ticket-number">#${myTicketNumber}</div>
        <div class="email-display">${email}<br>Анги: ${studentClass}</div>
    `),
  );

  enqueueSheetJob(async () => {
    const newRow = await sheet.addRow({
      Дугаар: myTicketNumber,
      "И-мэйл": email,
      Анги: studentClass,
      Огноо: new Date().toLocaleString("mn-MN", {
        timeZone: "Asia/Ulaanbaatar",
      }),
      Ирц: "Эзгүй",
      ID: ticketId,
    });
    const t = activeTickets.get(ticketId);
    if (t) t.rowNumber = newRow.rowNumber;
  });

  emailQueue.push({
    to: email,
    subject: `Тасалбарын дугаар #${myTicketNumber} & QR код`,
    htmlContent: `
        <div style="font-family: sans-serif; text-align: center; padding: 20px; background: #F9FAFB;">
            <div style="background: white; padding: 30px; border-radius: 16px; max-width: 400px; margin: 0 auto;">
                <h2>Орхон Сургуулийн Киноны Үдэш 🍿</h2>
                <p>Таны тасалбар баталгаажлаа!</p>
                <h1 style="font-size: 40px; margin: 10px 0;">#${myTicketNumber}</h1>
                <p><strong>Анги:</strong> ${studentClass}</p>
                <div style="background: #F3F4F6; padding: 20px; border-radius: 12px; margin: 20px 0;">
                    <p><strong>QR код хавсралтад байна. Орох хаалган дээр уншуулна уу.</strong></p>
                </div>
            </div>
        </div>
    `,
    qrBase64: qrCodeDataURI.split("base64,")[1],
  });
  processEmailQueue();
});

// --- ADMIN ---
function checkAdmin(req, res, next) {
  const key = req.query.key || req.body.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(403).send("Forbidden");
  next();
}

app.get("/admin/scanner", checkAdmin, (req, res) => {
  const key = req.query.key;
  res.send(`
    <!DOCTYPE html>
    <html lang="mn">
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Тасалбар шалгагч</title>
        <script src="https://unpkg.com/html5-qrcode"></script>
        <style>
            body { font-family: sans-serif; background: #111827; color: white; margin: 0; padding: 20px; text-align: center; }
            #reader { width: 100%; max-width: 500px; margin: 0 auto; border-radius: 12px; overflow: hidden; }
            #status { margin-top: 20px; padding: 15px; border-radius: 10px; font-weight: bold; font-size: 18px; white-space: pre-line; }
            .success { background: #059669; }
            .error { background: #DC2626; }
            .warning { background: #D97706; }
            #stats { margin-top: 20px; font-size: 14px; color: #9CA3AF; }
        </style>
    </head>
    <body>
        <h2>📷 QR Шалгагч</h2>
        <div id="reader"></div>
        <div id="status">QR код уншуулна уу...</div>
        <div id="stats"></div>
        <script>
            const ADMIN_KEY = ${JSON.stringify(key)};
            let isScanning = true;
            let lastScanned = "";
            let lastScanTime = 0;
            const html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 250} }, false);
            async function onScanSuccess(decodedText) {
                if(!isScanning) return;
                const now = Date.now();
                if (decodedText === lastScanned && now - lastScanTime < 2000) return;
                lastScanned = decodedText;
                lastScanTime = now;
                isScanning = false;
                const statusDiv = document.getElementById('status');
                statusDiv.innerText = "Шалгаж байна...";
                statusDiv.className = "";
                try {
                    const response = await fetch('/api/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
                        body: JSON.stringify({ ticketId: decodedText })
                    });
                    const result = await response.json();
                    statusDiv.innerText = result.message;
                    if(result.success) statusDiv.className = "success";
                    else if(result.alreadyScanned) statusDiv.className = "warning";
                    else statusDiv.className = "error";
                    if (result.stats) {
                      document.getElementById('stats').innerText =
                        "Орсон: " + result.stats.present + " / " + result.stats.total;
                    }
                } catch(e) {
                    statusDiv.innerText = "Алдаа гарлаа.";
                    statusDiv.className = "error";
                }
                setTimeout(() => {
                    isScanning = true;
                    statusDiv.innerText = "Дараагийн QR кодыг уншуулна уу...";
                    statusDiv.className = "";
                }, 2000);
            }
            html5QrcodeScanner.render(onScanSuccess);
        </script>
    </body>
    </html>
  `);
});

app.post("/api/verify", checkAdmin, (req, res) => {
  const { ticketId } = req.body;
  const ticket = activeTickets.get(ticketId);
  const getStats = () => {
    let present = 0;
    for (const t of activeTickets.values()) if (t.present) present++;
    return { present, total: activeTickets.size };
  };
  if (!ticket) {
    return res.json({
      success: false,
      alreadyScanned: false,
      message: "❌ Буруу эсвэл хуурамч QR код байна!",
      stats: getStats(),
    });
  }
  if (ticket.present) {
    return res.json({
      success: false,
      alreadyScanned: true,
      message: `⚠️ #${ticket.ticketNumber} (${ticket.studentClass})\n${ticket.email}\nХэдийнээ орсон!`,
      stats: getStats(),
    });
  }
  ticket.present = true;
  enqueueSheetJob(async () => {
    try {
      const rows = await sheet.getRows();
      const targetRow =
        (ticket.rowNumber &&
          rows.find((r) => r.rowNumber === ticket.rowNumber)) ||
        rows.find((r) => r.get("ID") === ticketId);
      if (targetRow) {
        targetRow.set("Ирц", "Ирсэн");
        await targetRow.save();
      }
    } catch (err) {
      console.error("Sheet update error:", err.message);
    }
  });
  return res.json({
    success: true,
    message: `✅ АМЖИЛТТАЙ!\n#${ticket.ticketNumber} • ${ticket.studentClass}\n${ticket.email}`,
    stats: getStats(),
  });
});

app.get("/health", (req, res) =>
  res.json({ ok: true, ticketCount, max: MAX_TICKETS }),
);

// Admin dashboard: see email account usage
app.get("/admin/status", checkAdmin, (req, res) => {
  maybeResetCounters();
  res.json({
    ticketCount,
    maxTickets: MAX_TICKETS,
    queuedEmails: emailQueue.length,
    queuedSheetWrites: sheetQueue.length,
    emailAccounts: BREVO_ACCOUNTS.map((a) => ({
      name: a.name,
      configured: !!a.apiKey,
      sentToday: a.sentToday,
      dailyLimit: a.dailyLimit,
      remaining: Math.max(0, a.dailyLimit - a.sentToday),
      blocked: Date.now() < a.blockedUntil,
    })),
    totalEmailsRemaining: BREVO_ACCOUNTS.reduce(
      (sum, a) =>
        a.apiKey && Date.now() >= a.blockedUntil
          ? sum + Math.max(0, a.dailyLimit - a.sentToday)
          : sum,
      0,
    ),
  });
});

// Test email — use after deploy to verify both accounts work
// /test-email?key=YOURKEY&to=youremail@example.com
app.get("/test-email", checkAdmin, async (req, res) => {
  const to = req.query.to;
  if (!to) return res.send("Add ?to=youremail@example.com");
  try {
    const result = await sendEmailViaBrevo({
      to,
      subject: "Test from movie night server",
      htmlContent: "<p>Brevo working ✅</p>",
    });
    res.send(`Email sent to ${to} via account: ${result.account}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

initializeData()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Сервер ${PORT} порт дээр ажиллаж байна`);
      const configured = BREVO_ACCOUNTS.filter((a) => a.apiKey).length;
      console.log(`📧 Brevo accounts configured: ${configured}/2`);
      console.log(`📧 Total daily email capacity: ${configured * 290}`);
    });
  })
  .catch((err) => {
    console.error("❌ Failed to initialize:");
    console.error(err);
    console.error("\nFull error message:", err.message);
    console.error("\nPress any key to exit...");
    setTimeout(() => process.exit(1), 30000); // wait 30 sec so you can read it
  });

process.on("unhandledRejection", (err) => console.error("Unhandled:", err));
process.on("uncaughtException", (err) => console.error("Exception:", err));
