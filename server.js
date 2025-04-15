const express = require("express");
const net = require("net");
const tls = require("tls");
const { Buffer } = require("buffer");
const axios = require("axios");
require("dotenv").config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

async function getAccessToken(clientId, clientSecret, refreshToken) {
  console.log(clientId)
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
  const smtpHost = "smtp.gmail.com";
  let socket;
  let responseBuffer = '';
  let timeout;

  // Get OAuth token
  const accessToken = await getAccessToken(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REFRESH_TOKEN
  );
  
  if (!accessToken?.access_token) {
    throw new Error("Failed to obtain OAuth access token");
  }

  // Prepare authentication string
  const authString = `user=${from}\x01auth=Bearer ${accessToken.access_token}\x01\x01`;
  const xoauth2 = Buffer.from(authString).toString("base64");

  // Modified command sequence - now includes waiting for initial 220
  const commands = [
    { expect: /220/ }, // Wait for server greeting first
    { cmd: `EHLO ${smtpHost}\r\n`, expect: /250/ },
    { cmd: "STARTTLS\r\n", expect: /220/ },
    { cmd: `EHLO ${smtpHost}\r\n`, expect: /250/, tls: true },
    { cmd: "AUTH XOAUTH2 " + xoauth2 + "\r\n", expect: /235/ },
    { cmd: `MAIL FROM:<${from}>\r\n`, expect: /250/ },
    { cmd: `RCPT TO:<${to}>\r\n`, expect: /250/ },
    { cmd: "DATA\r\n", expect: /354/ },
    { cmd: `Subject: ${subject}\r\nFrom: ${from}\r\nTo: ${to}\r\n\r\n${body}\r\n.\r\n`, expect: /250/ },
    { cmd: "QUIT\r\n", expect: /221/ }
  ];

  return new Promise((resolve, reject) => {
    let currentCommand = 0;
    let upgradedToTLS = false;

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        socket.end();
        reject(new Error("SMTP timeout - no response from server"));
      }, 30000);
    };

    const sendNextCommand = () => {
      if (currentCommand >= commands.length) return;
      
      // Only send if there's a command to send (first step is just waiting)
      if (commands[currentCommand].cmd) {
        resetTimeout();
        console.log('Sending:', commands[currentCommand].cmd.trim());
        socket.write(commands[currentCommand].cmd);
      }
    };

    // Create initial connection
    socket = net.createConnection(port, smtpHost, () => {
      console.log("Connected to SMTP server");
      resetTimeout();
      // Don't send anything yet - wait for server greeting
    });

    socket.on('data', (data) => {
      responseBuffer += data.toString();
      console.log('Received:', responseBuffer.trim());

      // Check for complete response (ends with \r\n)
      if (!responseBuffer.endsWith('\r\n')) {
        return; // Wait for complete response
      }

      resetTimeout();

      const expectedResponse = commands[currentCommand]?.expect;
      const isError = /^[45]\d{2}/.test(responseBuffer);

      if (isError) {
        socket.end();
        reject(new Error(`SMTP Error: ${responseBuffer.trim()}`));
        return;
      }

      if (expectedResponse && expectedResponse.test(responseBuffer)) {
        responseBuffer = '';
        
        // Handle TLS upgrade
        if (commands[currentCommand].cmd === "STARTTLS\r\n") {
          const secureSocket = tls.connect({
            socket: socket,
            rejectUnauthorized: true,
            servername: smtpHost
          }, () => {
            console.log("TLS upgrade complete");
            upgradedToTLS = true;
            currentCommand++;
            sendNextCommand();
          });

          secureSocket.on('error', (err) => {
            console.error('TLS error:', err);
            reject(err);
          });
          
          secureSocket.on('data', socket.emit.bind(socket, 'data'));
          socket = secureSocket;
          return;
        }

        currentCommand++;
        if (currentCommand < commands.length) {
          sendNextCommand();
        } else {
          socket.end();
          resolve({ success: true });
        }
      } else {
        // Unexpected response
        socket.end();
        reject(new Error(`Unexpected SMTP response: ${responseBuffer.trim()}`));
      }
    });


    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on('end', () => {
      clearTimeout(timeout);
      if (currentCommand < commands.length - 1) {
        reject(new Error("Connection ended prematurely"));
      }
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
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
