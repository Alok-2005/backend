import express from 'express';
import mongoose from 'mongoose';
import Twilio from 'twilio';
import PDFDocument from 'pdfkit';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Payment from './models/payment.model.js';
import { connectDb } from './models/db.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// WhatsApp Webhook
const whatsappVerify = async (req, res) => {
  try {
    const { From: from, Body: message } = req.body;

    console.log('Webhook Message:', message);

    const match = message.match(/Transaction ID: ([^\n]+)/);
    if (!match) {
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Invalid format. Please include "Transaction ID: YOUR_ID".',
      });
      return res.status(400).json({ success: false, message: 'Invalid format' });
    }

    const transactionId = match[1].trim();
    const payment = await Payment.findOne({ transactionId, done: true });

    if (!payment) {
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Payment not found or not completed. Please check your Transaction ID.',
      });
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    // PDF creation with buffer
    const doc = new PDFDocument();
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    doc.fontSize(20).text('Payment Receipt', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Name: ${payment.name || 'Unknown'}`);
    doc.text(`Amount: ₹${payment.amount || 0}`);
    doc.text(`Message: ${payment.message || 'No message'}`);
    doc.text(`UPI ID: ${payment.upiId || 'Not available'}`);
    doc.text(`Transaction ID: ${payment.transactionId || 'Not available'}`);
    doc.text(`Razorpay Payment ID: ${payment.razorpayPaymentId || 'Not available'}`);
    doc.text(`Date: ${payment.updatedAt ? new Date(payment.updatedAt).toLocaleString() : 'N/A'}`);
    doc.text(`Recipient: ${payment.to_user || 'N/A'}`);

    const receiptsDir = path.join(__dirname, 'receipts');
    await fs.mkdir(receiptsDir, { recursive: true });

    const fileName = `receipt-${transactionId}.pdf`;
    const filePath = path.join(receiptsDir, fileName);

    const writeStream = createWriteStream(filePath);
    doc.pipe(writeStream);
    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const pdfUrl = `https://iskconprojectbackend.onrender.com/api/receipts/${fileName}`;

    await twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: from,
      body: `Thank you for your donation of ₹${payment.amount}. Your receipt is ready.`,
      mediaUrl: [pdfUrl],
    });

    console.log('Receipt sent to WhatsApp:', from);

    return res.status(200).json({ success: true, pdfUrl });
  } catch (err) {
    console.error('Webhook Error:', err);
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: req.body.From || 'whatsapp:+1234567890',
        body: 'An error occurred while processing your request.',
      });
    } catch (msgErr) {
      console.error('Failed to send error message:', msgErr.message);
    }
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PDF route
const receiptGenerate = async (req, res) => {
  try {
    const { filename } = req.params;

    if (!filename.match(/^receipt-[a-zA-Z0-9_-]+\.pdf$/)) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }

    const filePath = path.join(__dirname, 'receipts', filename);
    await fs.access(filePath);
    const fileBuffer = await fs.readFile(filePath);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileBuffer.length - 1;
      const chunk = fileBuffer.slice(start, end + 1);

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileBuffer.length}`);
      res.setHeader('Content-Length', chunk.length);
      return res.send(chunk);
    }

    res.status(200).send(fileBuffer);
  } catch (error) {
    console.error('Error serving PDF:', error.message);
    if (error.code === 'ENOENT') {
      return res.status(404).json({ success: false, message: 'PDF not found' });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Static serve receipts
app.use('/api/receipts', express.static(path.join(__dirname, 'receipts'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.pdf')) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// Routes
app.post('/api/whatsapp/verify', whatsappVerify);
app.get('/api/receipts/:filename', receiptGenerate);
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  connectDb();
});


// import express from 'express';
// import mongoose from 'mongoose';
// import Twilio from 'twilio';
// import dotenv from 'dotenv';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { connectDb } from './models/db.js';
// import Payment from './models/payment.model.js';

// dotenv.config();

// const app = express();
// const port = process.env.PORT || 3000;

// // __dirname equivalent in ES Modules
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// // Middleware
// app.use(express.urlencoded({ extended: true }));
// app.use(express.json());

// // Twilio Client
// const twilioClient = Twilio(
//   process.env.TWILIO_ACCOUNT_SID,
//   process.env.TWILIO_AUTH_TOKEN
// );

// // ✅ WhatsApp Verification Route (Updated - No PDF)
// const whatsappVerify = async (req, res) => {
//   try {
//     const params = req.body;
//     console.log('Twilio Webhook Body:', JSON.stringify(params, null, 2));

//     const from = params.From;
//     const message = params.Body;

//     const transactionIdMatch = message.match(/Transaction ID: ([^\n]+)/);
//     if (!transactionIdMatch) {
//       console.error('No Transaction ID found in message:', message);
//       await twilioClient.messages.create({
//         from: 'whatsapp:+14155238886',
//         to: from,
//         body: 'Invalid format. Please include "Transaction ID: [your_id]".',
//       });
//       return res.status(400).json({ success: false, message: 'Invalid message format' });
//     }

//     const transactionId = transactionIdMatch[1].trim();
//     console.log('Extracted Transaction ID:', transactionId);

//     const payment = await Payment.findOne({ transactionId, done: true });
//     if (!payment) {
//       console.error('Payment not found or not completed:', transactionId);
//       await twilioClient.messages.create({
//         from: 'whatsapp:+14155238886',
//         to: from,
//         body: 'Payment not found or not completed. Please check your Transaction ID.',
//       });
//       return res.status(404).json({ success: false, message: 'Payment not found' });
//     }

//     console.log('Payment Found:', JSON.stringify(payment.toObject(), null, 2));

//     // ✅ Send Thank-you WhatsApp message
//     const thankYouMessage = `Thank you for donating ₹${payment.amount || 0}! We appreciate your support.`;
//     await twilioClient.messages.create({
//       from: 'whatsapp:+14155238886',
//       to: from,
//       body: thankYouMessage,
//     });

//     return res.status(200).json({ success: true, message: 'Thank-you message sent' });
//   } catch (error) {
//     console.error('Error in WhatsApp webhook:', error.message);
//     try {
//       await twilioClient.messages.create({
//         from: 'whatsapp:+14155238886',
//         to: req.body.From || 'whatsapp:+1234567890',
//         body: 'An error occurred. Please try again later.',
//       });
//     } catch (sendError) {
//       console.error('Error sending fallback message:', sendError.message);
//     }
//     return res.status(500).json({ success: false, message: 'Server error', error: error.message });
//   }
// };

// // ✅ Health check route
// app.get('/health', (req, res) => {
//   res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
// });

// // ✅ API Routes
// app.post('/api/whatsapp/verify', whatsappVerify);

// // ✅ Start server
// app.listen(port, () => {
//   console.log(`Server is running on port ${port}`);
//   connectDb();
// });
