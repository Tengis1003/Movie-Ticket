require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

let ticketCount = 0;
const MAX_TICKETS = 400;
const claimedEmails = new Set();

// --- 1. EMAIL SETUP ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- 2. GOOGLE SHEETS SETUP ---
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  // This replace() function is crucial for Render to read the key correctly
  key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : "",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(
  process.env.GOOGLE_SHEET_ID,
  serviceAccountAuth,
);

// --- MODERN MINIMALIST DESIGN TEMPLATE ---
const generateHTML = (content) => `
<!DOCTYPE html>
<html lang="mn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>Киноны тасалбар</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background-color: #F9FAFB;
            color: #111827;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }
        .card {
            background: #FFFFFF;
            width: 100%;
            max-width: 380px;
            padding: 40px 30px 20px 30px;
            border-radius: 24px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.06);
            text-align: center;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        }
        h1 { font-size: 22px; font-weight: 700; margin: 0 0 8px 0; }
        p { color: #6B7280; font-size: 15px; margin: 0 0 24px 0; line-height: 1.5; }
        .emoji-header { font-size: 42px; margin-bottom: 16px; display: block; }
        
        input {
            width: 100%;
            padding: 16px;
            margin-bottom: 16px;
            border: 1px solid #E5E7EB;
            border-radius: 14px;
            font-size: 15px;
            box-sizing: border-box;
            background-color: #F9FAFB;
            transition: all 0.2s ease;
            font-family: inherit;
        }
        input:focus {
            outline: none;
            border-color: #6366F1;
            background-color: #FFFFFF;
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
        }
        
        button {
            width: 100%;
            padding: 16px;
            background-color: #111827;
            color: white;
            border: none;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            font-family: inherit;
        }
        button:hover { background-color: #374151; }
        button:active { transform: scale(0.98); }
        
        .ticket-number { font-size: 48px; font-weight: 700; color: #111827; margin: 16px 0; }
        .email-display { background: #F3F4F6; padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 600; color: #4B5563; word-break: break-all; margin-bottom: 20px;}
        
        .alert-success { background-color: #ECFDF5; border: 1px solid #D1FAE5; color: #059669; padding: 14px; border-radius: 12px; font-size: 14px; font-weight: 600; margin-top: 10px; }
        .alert-error { color: #DC2626; }
        
        .link-back { color: #6366F1; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block; margin-top: 10px; }
        
        /* NEW STYLES: Poster and Footer */
        .poster-img { width: 100%; border-radius: 14px; margin-top: 20px; object-fit: cover; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
        .footer-text { margin-top: 30px; font-size: 13px; color: #9CA3AF; font-weight: 600; }
    </style>
</head>
<body>
    <div class="card">
        ${content}
        <div class="footer-text">Developed by Tengis</div>
    </div>
</body>
</html>
`;

// 3. GET /scan : Show the form
app.get("/scan", (req, res) => {
  if (ticketCount >= MAX_TICKETS) {
    return res.status(403).send(
      generateHTML(`
            <span class="emoji-header">🛑</span>
            <h1 class="alert-error">Уучлаарай, дууссан!</h1>
            <p>Нийт ${MAX_TICKETS} тасалбар хэдийнээ дууссан байна.</p>
        `),
    );
  }

  res.send(
    generateHTML(`
        <span class="emoji-header">🍿</span>
        <h1>Киноны үдэш</h1>
        <p>Тасалбараа авахын тулд мэдээллээ оруулна уу.</p>
        <form action="/scan" method="POST" style="margin-top: 24px;">
            <input type="email" name="studentEmail" placeholder="И-мэйл: ner.ovog@orkhonschool.edu.mn" required>
            <input type="text" name="studentClass" placeholder="Анги: (Жишээ нь: 10A)" required>
            <button type="submit">Тасалбар авах</button>
        </form>
        <img src="https://images.unsplash.com/photo-1440404653325-ab127d49abc1?ixlib=rb-1.2.1&auto=format&fit=crop&w=400&q=80" alt="Movie Poster" class="poster-img">
    `),
  );
});

// 4. POST /scan : Process the form (Notice the "async" keyword here)
app.post("/scan", async (req, res) => {
  const email = req.body.studentEmail.trim().toLowerCase();
  const studentClass = req.body.studentClass.trim(); // Get the new class input

  // SECURITY CHECK
  if (!email.endsWith("@orkhonschool.edu.mn")) {
    return res.send(
      generateHTML(`
            <span class="emoji-header">⚠️</span>
            <h1 class="alert-error">Буруу хаяг</h1>
            <p>Та зөвхөн @orkhonschool.edu.mn өргөтгөлтэй и-мэйл хаяг ашиглах ёстой.</p>
            <a href="/scan" class="link-back">⬅ Буцах</a>
        `),
    );
  }

  // CHECK 1: Already claimed?
  if (claimedEmails.has(email)) {
    return res.send(
      generateHTML(`
            <span class="emoji-header">🎟️</span>
            <h1 style="color: #059669;">Баталгаажсан байна!</h1>
            <p>Тасалбар хэдийнээ олгогдсон байна. Орох хаалган дээр энэ дэлгэцийг үзүүлнэ үү.</p>
            <div class="email-display">${email}</div>
        `),
    );
  }

  // CHECK 2: Claim the ticket
  if (ticketCount < MAX_TICKETS) {
    ticketCount++;
    claimedEmails.add(email);

    // --- SAVE TO GOOGLE SHEETS ---
    try {
      await doc.loadInfo(); // Connect to the sheet
      const sheet = doc.sheetsByIndex[0]; // Get the first tab
      await sheet.addRow({
        Дугаар: ticketCount,
        "И-мэйл": email,
        Анги: studentClass,
        Огноо: new Date().toLocaleString("mn-MN"),
      });
      console.log(`Saved Ticket #${ticketCount} to Google Sheets`);
    } catch (err) {
      console.error("Google Sheets Error - Could not save data:", err);
    }

    // --- SEND EMAIL ---
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Тасалбарын дугаар #${ticketCount}`,
      html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F9FAFB; padding: 40px 20px;">
                    <div style="max-width: 400px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; padding: 40px 30px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
                        <div style="font-size: 40px; margin-bottom: 10px;">🍿</div>
                        <h2 style="color: #111827; margin-top: 0; font-size: 20px;">Орхон Сургуулийн Киноны Үдэш</h2>
                        <p style="color: #6B7280; font-size: 15px;">Таны тасалбар амжилттай баталгаажлаа!</p>
                        
                        <div style="background: #F3F4F6; border-radius: 12px; padding: 20px; margin: 30px 0;">
                            <p style="color: #6B7280; margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">Тасалбарын дугаар</p>
                            <h1 style="color: #111827; font-size: 48px; margin: 10px 0;">#${ticketCount}</h1>
                        </div>

                        <p style="color: #4B5563; font-size: 14px; background: #F9FAFB; padding: 10px; border-radius: 8px; margin-bottom: 5px;"><strong>${email}</strong></p>
                        <p style="color: #4B5563; font-size: 14px; background: #F9FAFB; padding: 10px; border-radius: 8px; margin-top: 0;"><strong>Анги: ${studentClass}</strong></p>
                        <hr style="border: none; border-top: 1px dashed #E5E7EB; margin: 30px 0;">
                        <p style="color: #6B7280; font-size: 14px; margin-bottom: 0;">Орох хаалган дээр утсан дээрх энэхүү и-мэйлийг үзүүлнэ үү. Киногоо сайхан үзээрэй!</p>
                    </div>
                </div>
            `,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) console.log("И-мэйл илгээхэд алдаа гарлаа:", email, error);
    });

    return res.send(
      generateHTML(`
            <span class="emoji-header">🎉</span>
            <h1>Амжилттай!</h1>
            <p>Та бол нийт ${MAX_TICKETS} тасалбарын...</p>
            <div class="ticket-number">#${ticketCount}</div>
            <div class="email-display">${email}<br>Анги: ${studentClass}</div>
            <div class="alert-success">
                ✅ И-мэйл руу баталгаажуулах зурвас илгээлээ
            </div>
        `),
    );
  } else {
    // CHECK 3: Sold out
    return res.status(403).send(
      generateHTML(`
            <span class="emoji-header">🛑</span>
            <h1 class="alert-error">Уучлаарай, дууссан!</h1>
            <p>Дөнгөж сая бүх ${MAX_TICKETS} тасалбар дууслаа.</p>
        `),
    );
  }
});

app.listen(PORT, () => {
  console.log(`Сервер ${PORT} порт дээр ажиллаж байна`);
});
