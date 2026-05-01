require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const crypto = require("crypto");
const QRCode = require("qrcode");
const app = express();
const PORT = process.env.PORT || 3000;
const poster_link =
  "https://cdn11.bigcommerce.com/s-ydriczk/images/stencil/1500x1500/products/89058/93685/Joker-2019-Final-Style-steps-Poster-buy-original-movie-posters-at-starstills__62518.1669120603.jpg?c=2&imbypass=on";

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Allows the scanner to send JSON data
app.use(express.static("public"));

let ticketCount = 0;
const MAX_TICKETS = 400;

// Memory storage to make scanning lightning-fast
const claimedEmails = new Set();
const activeTickets = new Map(); // Stores ticket data by their unique ID

// --- 1. EMAIL SETUP (With IPv4 Fix) ---
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

// --- 2. GOOGLE SHEETS SETUP ---
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

// --- 3. LOAD EXISTING TICKETS FROM SHEETS ON STARTUP ---
async function initializeData() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    ticketCount = rows.length;
    rows.forEach((row) => {
      const email = row.get("И-мэйл");
      const id = row.get("ID");
      const status = row.get("Ирц");

      if (email) claimedEmails.add(email);
      if (id) {
        activeTickets.set(id, {
          email: email,
          studentClass: row.get("Анги"),
          ticketCount: row.get("Дугаар"),
          present: status === "Ирсэн",
        });
      }
    });
    console.log(
      `✅ Loaded ${ticketCount} existing tickets from Google Sheets.`,
    );
  } catch (error) {
    console.error("⚠️ Could not load initial data from Google Sheets:", error);
  }
}
initializeData();

// --- DESIGN TEMPLATE ---
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
        .alert-success { background-color: #ECFDF5; border: 1px solid #D1FAE5; color: #059669; padding: 14px; border-radius: 12px; font-size: 14px; font-weight: 600; margin-top: 10px; }
        .alert-error { color: #DC2626; }
        .poster-img { width: 100%; border-radius: 14px; margin-top: 20px; object-fit: cover; }
        .footer-text { margin-top: 30px; font-size: 13px; color: #9CA3AF; font-weight: 600; }
    </style>
</head>
<body>
    <div class="card">
        ${content}
        <div class="footer-text">Developed by 12A Tengis</div>
    </div>
</body>
</html>
`;

// --- ROUTE: SHOW FORM ---
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
  res.send(
    generateHTML(`
        <span class="emoji-header"><img src="/width_550.webp" width=100px alt=""></span>
        <h1>Киноны үдэш</h1>
        <p>Мэдээллээ оруулан тасалбар болон QR кодоо аваарай.</p>
        <form action="/scan" method="POST" style="margin-top: 24px;">
            <input type="email" name="studentEmail" placeholder="ner.ovog@orkhonschool.edu.mn" required>
            <input type="text" name="studentClass" placeholder="Анги: (Жишээ нь: 10A)" required>
            <button type="submit">Тасалбар авах</button>
        </form>
        <img src=${poster_link} alt="Poster" class="poster-img">
    `),
  );
});

// --- ROUTE: PROCESS TICKET & SEND QR ---
app.post("/scan", async (req, res) => {
  const email = req.body.studentEmail.trim().toLowerCase();
  const studentClass = req.body.studentClass.trim();

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

  if (ticketCount >= MAX_TICKETS) {
    return res
      .status(403)
      .send(
        generateHTML(
          `<span class="emoji-header">🛑</span><h1 class="alert-error">Уучлаарай, дууссан!</h1>`,
        ),
      );
  }

  ticketCount++;
  const ticketId = crypto.randomBytes(6).toString("hex"); // Generate unique ID

  claimedEmails.add(email);
  activeTickets.set(ticketId, {
    email,
    studentClass,
    ticketCount,
    present: false,
  });

  // 1. Save to Google Sheets
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      Дугаар: ticketCount,
      "И-мэйл": email,
      Анги: studentClass,
      Огноо: new Date().toLocaleString("mn-MN"),
      Ирц: "Эзгүй",
      ID: ticketId,
    });
  } catch (err) {
    console.error("Sheets Save Error:", err);
  }

  // 2. Generate QR Code
  const qrCodeDataURI = await QRCode.toDataURL(ticketId);

  // 3. Send Email with QR Code Embedded
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: `Тасалбарын дугаар #${ticketCount} & QR код`,
    html: `
        <div style="font-family: sans-serif; text-align: center; padding: 20px; background: #F9FAFB;">
            <div style="background: white; padding: 30px; border-radius: 16px; max-width: 400px; margin: 0 auto;">
                <h2>Орхон Сургуулийн Киноны Үдэш 🍿</h2>
                <p>Таны тасалбар баталгаажлаа!</p>
                <h1 style="font-size: 40px; margin: 10px 0;">#${ticketCount}</h1>
                <p><strong>Анги:</strong> ${studentClass}</p>
                <div style="background: #F3F4F6; padding: 20px; border-radius: 12px; margin: 20px 0;">
                    <p style="margin-bottom: 10px;"><strong>Орох хаалган дээр энэхүү QR кодыг уншуулна уу:</strong></p>
                    <img src="cid:qrcode" style="width: 200px; height: 200px;" alt="QR Code">
                </div>
            </div>
        </div>
    `,
    attachments: [
      {
        filename: "qrcode.png",
        content: qrCodeDataURI.split("base64,")[1],
        encoding: "base64",
        cid: "qrcode",
      },
    ],
  };

  transporter.sendMail(mailOptions, (err) => {
    if (err) console.log("Email Error:", err);
  });

  return res.send(
    generateHTML(`
        <span class="emoji-header">🎉</span><h1>Амжилттай!</h1>
        <p>И-мэйл рүү тань QR код илгээгдлээ. Хаалган дээр уншуулж орно уу.</p>
        <div class="ticket-number">#${ticketCount}</div>
        <div class="email-display">${email}<br>Анги: ${studentClass}</div>
  `),
  );
});

// ======================================================
// --- ADMIN SCANNER SECTION (For your phone) ---
// ======================================================

// The secret page you open on your phone: e.g. /admin/scanner
app.get("/admin/scanner", (req, res) => {
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
            #status { margin-top: 20px; padding: 15px; border-radius: 10px; font-weight: bold; font-size: 18px; }
            .success { background: #059669; }
            .error { background: #DC2626; }
            .warning { background: #D97706; }
        </style>
    </head>
    <body>
        <h2>📷 QR Шалгагч</h2>
        <div id="reader"></div>
        <div id="status">QR код уншуулна уу...</div>

        <script>
            let isScanning = true;
            const html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 250} }, false);
            
            async function onScanSuccess(decodedText) {
                if(!isScanning) return;
                isScanning = false; // Pause scanning
                
                const statusDiv = document.getElementById('status');
                statusDiv.innerText = "Шалгаж байна...";
                statusDiv.className = "";

                try {
                    const response = await fetch('/api/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ticketId: decodedText })
                    });
                    const result = await response.json();
                    
                    statusDiv.innerText = result.message;
                    if(result.success) statusDiv.className = "success";
                    else if(result.alreadyScanned) statusDiv.className = "warning";
                    else statusDiv.className = "error";

                } catch(e) {
                    statusDiv.innerText = "Алдаа гарлаа. Интернэт холболтоо шалгана уу.";
                    statusDiv.className = "error";
                }

                // Resume scanner after 3 seconds
                setTimeout(() => { 
                    isScanning = true; 
                    statusDiv.innerText = "Дараагийн QR кодыг уншуулна уу...";
                    statusDiv.className = "";
                }, 3000);
            }
            html5QrcodeScanner.render(onScanSuccess);
        </script>
    </body>
    </html>
    `);
});

// The API that checks the QR code
app.post("/api/verify", async (req, res) => {
  const { ticketId } = req.body;
  const ticket = activeTickets.get(ticketId);

  // 1. Fake or Wrong QR Code
  if (!ticket) {
    return res.json({
      success: false,
      alreadyScanned: false,
      message: "❌ Буруу эсвэл хуурамч QR код байна!",
    });
  }

  // 2. Already Scanned
  if (ticket.present) {
    return res.json({
      success: false,
      alreadyScanned: true,
      message: `⚠️ ${ticket.email} хэдийнээ орсон байна!`,
    });
  }

  // 3. Success! Mark as present
  ticket.present = true;

  // Update Google Sheets in the background
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const targetRow = rows.find((r) => r.get("ID") === ticketId);

    if (targetRow) {
      targetRow.set("Ирц", "Ирсэн");
      await targetRow.save();
    }
  } catch (err) {
    console.error("Error updating sheet:", err);
  }

  return res.json({
    success: true,
    message: `✅ АМЖИЛТТАЙ!\nАнги: ${ticket.studentClass}\nОрлоо: ${ticket.email}`,
  });
});

app.listen(PORT, () => {
  console.log(`Сервер ${PORT} порт дээр ажиллаж байна`);
});
