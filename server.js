require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const crypto = require("crypto");
const QRCode = require("qrcode");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-in-env";
const MAX_TICKETS = 400;

// --- EVENT CONFIG (change monthly) ---
// Format: year, month (1-12), day, hour (0-23), minute — all in Ulaanbaatar time (UTC+8)
const EVENT_DATE = { year: 2026, month: 5, day: 7, hour: 16, minute: 30 };

function formatEventDate() {
  const { year, month, day, hour, minute } = EVENT_DATE;
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}/${pad(month)}/${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

function isEventPast() {
  const { year, month, day, hour, minute } = EVENT_DATE;
  // Ulaanbaatar is UTC+8, so subtract 8 hours to get UTC
  const eventUTC = Date.UTC(year, month - 1, day, hour - 8, minute);
  return Date.now() > eventUTC;
}

// --- STUDENT ALLOWLIST ---
// Reads public/students.txt at startup (one email per line)
let allowedEmails = new Set();
try {
  const studentsPath = path.join(__dirname, "public", "students.txt");
  const content = fs.readFileSync(studentsPath, "utf-8");
  allowedEmails = new Set(
    content
      .split(/\r?\n/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && e.includes("@")),
  );
  console.log(
    `✅ Loaded ${allowedEmails.size} allowed emails from public/students.txt`,
  );
} catch (err) {
  console.warn(
    "⚠️ public/students.txt not found — anyone with a school email can sign up",
  );
}

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
  if (isEventPast()) {
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🎬</span><h1>Үйл явдал дууссан</h1><p>Энэ удаагийн киноны үдэш дууссан байна. Дараагийн арга хэмжээг хүлээж байгаарай!</p>`,
        ),
      );
  }
  if (ticketCount >= MAX_TICKETS) {
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🛑</span><h1 class="alert-error">Уучлаарай, дууссан!</h1><p>Нийт ${MAX_TICKETS} тасалбар дууссан байна.</p>`,
        ),
      );
  }
  const currentDateTime = formatEventDate();
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
  if (isEventPast()) {
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🎬</span><h1>Үйл явдал дууссан</h1><p>Бүртгэл хаагдсан.</p>`,
        ),
      );
  }
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
  if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
    return res.send(
      generateHTML(
        `<span class="emoji-header">🚫</span><h1 class="alert-error">Бүртгэлгүй и-мэйл</h1><p>Энэ и-мэйл хаяг сурагчийн жагсаалтад байхгүй байна. Анги удирдсан багштайгаа холбогдоно уу.</p>`,
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
                <p style="color: #6B7280; margin: 4px 0 16px 0;">📅 ${formatEventDate()}</p>
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

// Lightweight endpoint just to validate a key (used by the login page)
app.post("/admin/login", (req, res) => {
  const key = (req.body && req.body.key) || req.headers["x-admin-key"];
  if (key === ADMIN_KEY) return res.json({ ok: true });
  return res.status(403).json({ ok: false, message: "Буруу нууц үг" });
});

// Scanner page is now PUBLIC at the URL level, but useless without the key.
// The key is entered in a login form and stored in localStorage.
// Every API call still goes through checkAdmin on the server, so this is safe.
app.get("/admin/scanner", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="mn">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Тасалбар шалгагч</title>
        <script src="https://unpkg.com/html5-qrcode"></script>
        <style>
            * { box-sizing: border-box; }
            body { font-family: -apple-system, system-ui, sans-serif; background: #111827; color: white; margin: 0; padding: 20px; text-align: center; min-height: 100vh; }
            #reader { width: 100%; max-width: 500px; margin: 0 auto; border-radius: 12px; overflow: hidden; }
            #status { margin-top: 20px; padding: 15px; border-radius: 10px; font-weight: bold; font-size: 18px; white-space: pre-line; }
            .success { background: #059669; }
            .error { background: #DC2626; }
            .warning { background: #D97706; }
            #stats { margin-top: 20px; font-size: 14px; color: #9CA3AF; }
            .hidden { display: none !important; }

            /* Login screen */
            .login-card { max-width: 380px; margin: 60px auto; background: #1F2937; padding: 40px 28px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
            .login-card h2 { margin: 0 0 8px 0; font-size: 22px; }
            .login-card p { margin: 0 0 24px 0; color: #9CA3AF; font-size: 14px; }
            .login-card input { width: 100%; padding: 14px; background: #111827; border: 1px solid #374151; border-radius: 12px; color: white; font-size: 16px; margin-bottom: 12px; }
            .login-card input:focus { outline: none; border-color: #6366F1; }
            .login-card button { width: 100%; padding: 14px; background: #6366F1; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; }
            .login-card button:hover { background: #4F46E5; }
            .login-error { color: #F87171; font-size: 14px; margin-top: 10px; min-height: 18px; }

            /* Top bar with logout */
            .topbar { display: flex; justify-content: space-between; align-items: center; max-width: 500px; margin: 0 auto 16px auto; }
            .topbar h2 { margin: 0; font-size: 18px; }
            .logout-btn { background: transparent; color: #9CA3AF; border: 1px solid #374151; padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; }
            .logout-btn:hover { color: white; border-color: #6B7280; }
        </style>
    </head>
    <body>
        <!-- LOGIN SCREEN -->
        <div id="loginScreen" class="login-card">
            <h2>🔐 Шалгагчид нэвтрэх</h2>
            <p>Зөвхөн зөвшөөрөгдсөн ажилтан нэвтэрнэ.</p>
            <input id="keyInput" type="password" placeholder="Нууц түлхүүр" autocomplete="off">
            <button id="loginBtn">Нэвтрэх</button>
            <div id="loginError" class="login-error"></div>
        </div>

        <!-- SCANNER SCREEN -->
        <div id="scannerScreen" class="hidden">
            <div class="topbar">
                <h2>📷 QR Шалгагч</h2>
                <button class="logout-btn" id="logoutBtn">Гарах</button>
            </div>
            <div id="reader"></div>
            <div id="status">QR код уншуулна уу...</div>
            <div id="stats"></div>
        </div>

        <script>
            const STORAGE_KEY = "movieNightAdminKey";
            let ADMIN_KEY = localStorage.getItem(STORAGE_KEY) || "";

            const loginScreen = document.getElementById("loginScreen");
            const scannerScreen = document.getElementById("scannerScreen");
            const keyInput = document.getElementById("keyInput");
            const loginBtn = document.getElementById("loginBtn");
            const loginError = document.getElementById("loginError");
            const logoutBtn = document.getElementById("logoutBtn");

            // Try auto-login if key is saved
            async function tryAutoLogin() {
                if (!ADMIN_KEY) return false;
                try {
                    const res = await fetch("/admin/login", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key: ADMIN_KEY })
                    });
                    return res.ok;
                } catch { return false; }
            }

            async function attemptLogin(key) {
                loginError.innerText = "";
                try {
                    const res = await fetch("/admin/login", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key })
                    });
                    if (res.ok) {
                        ADMIN_KEY = key;
                        localStorage.setItem(STORAGE_KEY, key);
                        showScanner();
                    } else {
                        loginError.innerText = "Буруу нууц түлхүүр";
                    }
                } catch (e) {
                    loginError.innerText = "Сүлжээний алдаа";
                }
            }

            loginBtn.addEventListener("click", () => attemptLogin(keyInput.value.trim()));
            keyInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") attemptLogin(keyInput.value.trim());
            });
            logoutBtn.addEventListener("click", () => {
                localStorage.removeItem(STORAGE_KEY);
                location.reload();
            });

            let scannerStarted = false;
            function showScanner() {
                loginScreen.classList.add("hidden");
                scannerScreen.classList.remove("hidden");
                if (!scannerStarted) startScanner();
                scannerStarted = true;
            }

            function startScanner() {
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
            }

            // Auto-login on page load if a saved key works
            (async () => {
                if (await tryAutoLogin()) {
                    showScanner();
                } else {
                    if (ADMIN_KEY) {
                        // Saved key was rejected (e.g. admin changed key) — clear it
                        localStorage.removeItem(STORAGE_KEY);
                        ADMIN_KEY = "";
                    }
                    keyInput.focus();
                }
            })();
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
    console.error("❌ Failed to initialize:", err);
    process.exit(1);
  });

process.on("unhandledRejection", (err) => console.error("Unhandled:", err));
process.on("uncaughtException", (err) => console.error("Exception:", err));
