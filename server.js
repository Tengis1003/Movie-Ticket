const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// This middleware allows Express to read the data submitted in the HTML form
app.use(express.urlencoded({ extended: true }));

let ticketCount = 0;
const MAX_TICKETS = 300;

// This Set acts as our database to remember which emails already have a ticket
const claimedEmails = new Set();

// 1. GET /scan : This shows the form when they scan the QR code
app.get('/scan', (req, res) => {
    // If tickets are sold out, don't even show the form
    if (ticketCount >= MAX_TICKETS) {
        return res.status(403).send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: red;">Sorry, Sold Out!</h1>
                <p>All ${MAX_TICKETS} tickets have already been claimed.</p>
            </div>
        `);
    }

    // Otherwise, show the form
    res.send(`
        <div style="text-align: center; font-family: sans-serif; padding-top: 50px; max-width: 400px; margin: auto;">
            <h1 style="color: #333;">Movie Night Tickets 🍿</h1>
            <p>Please enter your Orkhon School email to claim your ticket.</p>
            
            <form action="/scan" method="POST" style="margin-top: 20px;">
                <input 
                    type="email" 
                    name="studentEmail" 
                    placeholder="name.surname@orkhonschool.edu.mn" 
                    required 
                    style="width: 100%; padding: 10px; margin-bottom: 15px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 5px;"
                >
                <button type="submit" style="width: 100%; padding: 10px; background-color: #28a745; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer;">
                    Claim Ticket
                </button>
            </form>
        </div>
    `);
});

// 2. POST /scan : This runs when the user clicks "Claim Ticket"
app.post('/scan', (req, res) => {
    // Grab the email they typed in and force it to lowercase 
    // (so "Tengis@..." and "tengis@..." are treated as the same email)
    const email = req.body.studentEmail.trim().toLowerCase();

    // SECURITY CHECK: Make sure it is an Orkhon School email
    if (!email.endsWith('@orkhonschool.edu.mn')) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: red;">Invalid Email</h1>
                <p>You must use a valid @orkhonschool.edu.mn email address.</p>
                <a href="/scan" style="color: blue;">Go back and try again</a>
            </div>
        `);
    }

    // CHECK 1: Have we seen this email before?
    if (claimedEmails.has(email)) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: green;">Welcome Back!</h1>
                <p><strong>${email}</strong> already has a ticket.</p>
                <p>Please show this screen at the entrance.</p>
            </div>
        `);
    }

    // CHECK 2: Are there tickets left?
    if (ticketCount < MAX_TICKETS) {
        ticketCount++;
        claimedEmails.add(email); // Save their email so they can't claim another one
        
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: blue;">Ticket Claimed! 🎉</h1>
                <h2>You are ticket #${ticketCount} of ${MAX_TICKETS}</h2>
                <p>Ticket secured for: <strong>${email}</strong></p>
                <p>Please keep this page open or take a screenshot.</p>
            </div>
        `);
    } else {
        // CHECK 3: If 300 people claimed while they were filling out the form
        return res.status(403).send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: red;">Sorry, Sold Out!</h1>
                <p>All ${MAX_TICKETS} tickets were just claimed.</p>
            </div>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
