const express = require("express");
const cookieParser = require("cookie-parser");
const app = express();
const PORT = 3000;

// Middleware to read cookies
app.use(cookieParser());

// This variable acts as our global counter
let ticketCount = 0;
const MAX_TICKETS = 300;

app.get("/scan", (req, res) => {
  // 1. Check if the user already got a ticket previously
  if (req.cookies.hasTicket) {
    return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: green;">Welcome Back!</h1>
                <p>You already have a ticket. Please show this screen at the entrance.</p>
            </div>
        `);
  }

  // 2. If they don't have a ticket, check if there are any left
  if (ticketCount < MAX_TICKETS) {
    ticketCount++; // Add 1 to the global count

    // Give the user a cookie so if they refresh, it doesn't count as a new scan
    res.cookie("hasTicket", "true", { maxAge: 86400000 }); // Expires in 24 hours

    return res.send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: blue;">Ticket Claimed! 🍿</h1>
                <h2>You are ticket #${ticketCount} of ${MAX_TICKETS}</h2>
                <p>Please keep this page open or take a screenshot to show at the door.</p>
            </div>
        `);
  } else {
    // 3. If 300 people have already claimed tickets
    return res.status(403).send(`
            <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                <h1 style="color: red;">Sorry, Sold Out!</h1>
                <p>All ${MAX_TICKETS} tickets have already been claimed.</p>
            </div>
        `);
  }
});

app.listen(PORT, () => {
  console.log(`Movie ticket server is running on http://localhost:${PORT}`);
});
