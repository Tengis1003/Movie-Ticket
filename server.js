const express = require('express');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

let ticketCount = 0;
const MAX_TICKETS = 300;
const claimedEmails = new Set();

// Set up the Email Sender
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
    }
});

// --- NEW FIX: This helper function makes the website look great on mobile phones! ---
const generateHTML = (content) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>Movie Tickets</title>
</head>
<body style="font-family: sans-serif; background-color: #f4f4f9; margin: 0; padding: 20px;">
    <div style="text-align: center; max-width: 400px; margin: 20px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
        ${content}
    </div>
</body>
</html>
`;

// 1. GET /scan : Show the form
app.get('/scan', (req, res) => {
    if (ticketCount >= MAX_TICKETS) {
        return res.status(403).send(generateHTML(`
            <h1 style="color: red;">Sorry, Sold Out!</h1>
            <p>All ${MAX_TICKETS} tickets have already been claimed.</p>
        `));
    }

    // Notice we added "font-size: 16px" to the input. This stops iPhones from auto-zooming when typing!
    res.send(generateHTML(`
        <h1 style="color: #333; margin-top: 0;">Movie Night 🍿</h1>
        <p>Please enter your Orkhon School email to claim your ticket.</p>
        <form action="/scan" method="POST" style="margin-top: 20px;">
            <input type="email" name="studentEmail" placeholder="name.surname@orkhonschool.edu.mn" required style="width: 100%; padding: 12px; margin-bottom: 15px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 5px; font-size: 16px;">
            <button type="submit" style="width: 100%; padding: 12px; background-color: #28a745; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: bold;">
                Claim Ticket
            </button>
        </form>
    `));
});

// 2. POST /scan : Process the form
app.post('/scan', (req, res) => {
    const email = req.body.studentEmail.trim().toLowerCase();

    // SECURITY CHECK
    if (!email.endsWith('@orkhonschool.edu.mn')) {
        return res.send(generateHTML(`
            <h1 style="color: red;">Invalid Email</h1>
            <p>You must use a valid @orkhonschool.edu.mn email address.</p>
            <a href="/scan" style="color: blue; text-decoration: none; font-weight: bold;">⬅ Go back and try again</a>
        `));
    }

    // CHECK 1: Already claimed?
    if (claimedEmails.has(email)) {
        return res.send(generateHTML(`
            <h1 style="color: green;">Welcome Back!</h1>
            <p><strong>${email}</strong> already has a ticket.</p>
            <p>Please show this screen at the entrance.</p>
        `));
    }

    // CHECK 2: Claim the ticket and send the email
    if (ticketCount < MAX_TICKETS) {
        ticketCount++;
        claimedEmails.add(email);

        // --- NEW FIX: Email subject is exactly what you asked for ---
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email, 
            subject: `Your ticket number is #${ticketCount}`, 
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 20px; border: 2px dashed #ccc; border-radius: 10px; max-width: 400px; margin: auto;">
                    <h2 style="color: #333;">Orkhon School Movie Night 🍿</h2>
                    <p>Your ticket has been successfully submitted!</p>
                    <h1 style="color: blue; font-size: 28px;">You are ticket #${ticketCount}</h1>
                    <p style="color: #555;">Ticket holder: <strong>${email}</strong></p>
                    <hr style="border: 1px solid #eee; margin: 20px 0;">
                    <p>Please show this email on your phone at the entrance.</p>
                    <p>Enjoy the movie!</p>
                </div>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.log('Error sending email to:', email, error);
        });
        
        return res.send(generateHTML(`
            <h1 style="color: blue;">Ticket Claimed! 🎉</h1>
            <h2>You are ticket #${ticketCount} of ${MAX_TICKETS}</h2>
            <p style="word-wrap: break-word;">Ticket secured for: <br><strong>${email}</strong></p>
            <div style="background-color: #e8f5e9; padding: 10px; border-radius: 5px; margin-top: 20px;">
                <p style="color: green; margin: 0; font-weight: bold;">✅ We sent a confirmation email to your inbox!</p>
            </div>
        `));
    } else {
        // CHECK 3: Sold out
        return res.status(403).send(generateHTML(`
            <h1 style="color: red;">Sorry, Sold Out!</h1>
            <p>All ${MAX_TICKETS} tickets were just claimed.</p>
        `));
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
