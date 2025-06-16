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

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware to parse form data and JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Initialize Twilio client
const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// WhatsApp Verify Route
const whatsappVerify = async (req, res) => {
  try {
    const params = req.body;
    console.log('Twilio Webhook Body:', JSON.stringify(params, null, 2));

    const from = params.From; // Sender's WhatsApp number
    const message = params.Body; // Message content

    // Parse Transaction ID
    const transactionIdMatch = message.match(/Transaction ID: ([^\n]+)/);
    if (!transactionIdMatch) {
      console.error('No Transaction ID found in message:', message);
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Invalid message format. Please include the Transaction ID.',
      });
      return res.status(400).json({ success: false, message: 'Invalid message format' });
    }

    const transactionId = transactionIdMatch[1].trim();
    console.log('Extracted Transaction ID:', transactionId);

    // Verify payment
    const payment = await Payment.findOne({ transactionId, done: true });
    if (!payment) {
      console.error('Payment not found or not completed:', transactionId);
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Payment not found or not completed. Please check your Transaction ID.',
      });
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    console.log('Payment Found:', JSON.stringify(payment.toObject(), null, 2));

    // Generate PDF
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
    doc.text(`Recipient: ${payment.to_user}`);

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

    console.log('PDF Generated:', filePath);

    const pdfUrl = `https://iskconprojectbackend.onrender.com/api/receipts/${fileName}`;
    console.log('PDF URL:', pdfUrl);

    await twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: from,
      body: 'Here is your payment receipt.',
      mediaUrl: [pdfUrl],
    });

    console.log('PDF Sent to:', from);

    return res.status(200).json({ success: true, message: 'Receipt sent', pdfUrl });
  } catch (error) {
    console.error('Error in WhatsApp webhook:', error.message, error.stack);
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: req.body.From || 'whatsapp:+1234567890',
        body: 'An error occurred. Please try again later.',
      });
    } catch (sendError) {
      console.error('Error sending error message:', sendError.message);
    }
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// Receipt Download Route
const receiptGenerate = async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, 'receipts', filename);

    await fs.access(filePath);
    const fileBuffer = await fs.readFile(filePath);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    res.send(fileBuffer);
  } catch (error) {
    console.error('Error serving PDF:', error.message);
    return res.status(404).json({ success: false, message: 'PDF not found' });
  }
};

// Routes
app.post('/api/whatsapp/verify', whatsappVerify);
app.get('/api/receipts/:filename', receiptGenerate);

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  connectDb();
});
