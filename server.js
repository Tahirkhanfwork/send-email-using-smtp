const express = require("express");
const net = require("net");
const tls = require("tls");
const { Buffer } = require("buffer");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

async function getAccessToken(clientId, clientSecret, refreshToken) {
  try {
    const url = "https://oauth2.googleapis.com/token";
    const data = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    };

    const response = await axios.post(url, null, { params: data });
    return response.data;
  } catch (error) {
    console.error(
      "Failed to get access token:",
      error.response ? error.response.data : error
    );
    return null;
  }
}

async function sendEmailUsingSMTP(from, to, subject, body) {
  const port = 587;
  let smtpHost;

  try {
    smtpHost = "smtp.gmail.com";
  } catch (err) {
    throw new Error("Failed to determine SMTP server: " + err);
  }

  let socket, commands;
  const useTLS = false;

    const accessToken = await getAccessToken(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REFRESH_TOKEN
  );

  const authString = `user=${from}\x01auth=Bearer ${accessToken.access_token}\x01\x01`;
  const xoauth2 = Buffer.from(authString).toString("base64");

  commands = [
    `EHLO ${smtpHost}\r\n`,
    !useTLS ? "STARTTLS\r\n" : null,
    !useTLS ? `EHLO ${smtpHost}\r\n` : null,
    "AUTH XOAUTH2 " + xoauth2 + "\r\n",
    `MAIL FROM:<${from}>\r\n`,
    `RCPT TO:<${to}>\r\n`,
    "DATA\r\n",
    `Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\n\r\n${body}\r\n.\r\n`,
    "QUIT\r\n",
  ].filter(Boolean);

  let commandIndex = 0;

  function sendNextCommand() {
    if (commandIndex < commands.length) {
      socket.write(commands[commandIndex]);
      commandIndex++;
    }
  }

  function startTLSUpgrade() {
    if (commands[commandIndex - 1] === "STARTTLS\r\n") {
      socket = tls.connect({ socket, rejectUnauthorized: false }, () => {
        setTimeout(() => sendNextCommand(), 500);
      });
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  }

  async function onData(data) {
    if (commands[commandIndex - 1] === "STARTTLS\r\n") {
      startTLSUpgrade();
    } else if (commandIndex < commands.length) {
      sendNextCommand();
    } else {
      socket.end();
      const sentEmail = {
        from,
        to,
        subject,
        body,
        direction: "outbound",
        type: "email",
        date: new Date(),
        isSMTPSent: true,
      };
    }
  }

  function onError(err) {
    console.error("SMTP Error:", err);
  }

  function onEnd() {
    console.log("Disconnected from SMTP server");
  }

  if (useTLS) {
    socket = tls.connect(port, smtpHost, { rejectUnauthorized: false }, () => {
      console.log("Connected securely with TLS");
    });
  } else {
    socket = net.createConnection(port, smtpHost, () => {
      console.log("Connected to SMTP server (STARTTLS mode)");
    });
  }

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("end", onEnd);
}

app.post("/send-email", async (req, res) => {
  try {
    await sendEmailUsingSMTP(
      req.body.from,
      req.body.to,
      req.body.subject,
      req.body.body
    );
    res.json({ success: true, message: "Email sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
