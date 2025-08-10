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

// Get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio Client
const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ✅ Pre-create receipts directory on startup
const receiptsDir = path.join(__dirname, 'receipts');
await fs.mkdir(receiptsDir, { recursive: true }).catch(() => {});

// ✅ Optimized PDF generation function
const generatePDFBuffer = (payment) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true, // Enable buffer pages for faster generation
      autoFirstPage: true
    });
    
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // ✅ Simplified PDF content for faster generation
    doc.fontSize(18).text('Payment Receipt', { align: 'center' });
    doc.moveDown(0.5);
    
    // ✅ Use simpler text formatting to reduce processing time
    const receiptData = [
      `Name: ${payment.name || 'Unknown'}`,
      `Amount: ₹${payment.amount || 0}`,
      `Message: ${payment.message || 'No message'}`,
      `UPI ID: ${payment.upiId || 'Not available'}`,
      `Transaction ID: ${payment.transactionId || 'Not available'}`,
      `Razorpay Payment ID: ${payment.razorpayPaymentId || 'Not available'}`,
      `Date: ${payment.updatedAt ? new Date(payment.updatedAt).toLocaleString() : 'N/A'}`,
      `Recipient: ${payment.to_user}`
    ];

    doc.fontSize(11);
    receiptData.forEach(line => {
      doc.text(line);
      doc.moveDown(0.2);
    });

    doc.end();
  });
};

// ✅ Optimized WhatsApp Verification Route with timeout handling
const whatsappVerify = async (req, res) => {
  // ✅ Set response timeout to 12 seconds (within Twilio's 15-second limit)
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error('Request timed out after 12 seconds');
      res.status(408).json({ success: false, message: 'Request timeout' });
    }
  }, 12000);

  try {
    const startTime = Date.now();
    const params = req.body;
    console.log('Twilio Webhook Body:', JSON.stringify(params, null, 2));

    const from = params.From;
    const message = params.Body;

    // ✅ Faster regex matching
    const transactionIdMatch = message.match(/Transaction ID:\s*([^\n\r]+)/i);
    if (!transactionIdMatch) {
      console.error('No Transaction ID found in message:', message);
      clearTimeout(timeoutId);
      
      // ✅ Fire and forget error message (don't wait for it)
      twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Invalid message format. Please include the Transaction ID.',
      }).catch(err => console.error('Error sending invalid format message:', err));
      
      return res.status(400).json({ success: false, message: 'Invalid message format' });
    }

    const transactionId = transactionIdMatch[1].trim();
    console.log('Extracted Transaction ID:', transactionId, `Time: ${Date.now() - startTime}ms`);

    // ✅ Optimized database query with specific field selection
    const payment = await Payment.findOne(
      { transactionId, done: true },
      'name amount message upiId transactionId razorpayPaymentId updatedAt to_user' // Only select needed fields
    ).lean(); // Use lean() for faster queries

    if (!payment) {
      console.error('Payment not found or not completed:', transactionId);
      clearTimeout(timeoutId);
      
      // ✅ Fire and forget error message
      twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: from,
        body: 'Payment not found or not completed. Please check your Transaction ID.',
      }).catch(err => console.error('Error sending not found message:', err));
      
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    console.log('Payment Found:', `Time: ${Date.now() - startTime}ms`);

    // ✅ Generate PDF in memory (much faster than file operations)
    const pdfBuffer = await generatePDFBuffer(payment);
    console.log('PDF Generated in memory:', `Time: ${Date.now() - startTime}ms`);

    // ✅ Save file asynchronously (don't wait for it)
    const fileName = `receipt-${transactionId}-${Date.now()}.pdf`;
    const filePath = path.join(receiptsDir, fileName);
    
    // Fire and forget file save
    fs.writeFile(filePath, pdfBuffer).catch(err => 
      console.error('Error saving PDF file:', err)
    );

    const pdfUrl = `https://backend-m133.onrender.com/api/receipts/${fileName}`;
    console.log('PDF URL:', pdfUrl, `Time: ${Date.now() - startTime}ms`);

    // ✅ Send message with media - don't wait for response
    const messagePromise = twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: from,
      body: 'Here is your payment receipt.',
      mediaUrl: [pdfUrl],
    });

    // ✅ Respond immediately without waiting for Twilio message to send
    clearTimeout(timeoutId);
    const totalTime = Date.now() - startTime;
    console.log(`Total processing time: ${totalTime}ms`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Receipt sent', 
      pdfUrl,
      processingTime: totalTime 
    });

    // ✅ Handle message sending result asynchronously
    messagePromise
      .then(() => console.log('PDF Sent to:', from))
      .catch(err => console.error('Error sending WhatsApp message:', err));

  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Error in WhatsApp webhook:', error.message, error.stack);
    
    // ✅ Fire and forget error message
    if (req.body.From) {
      twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: req.body.From,
        body: 'An error occurred. Please try again later.',
      }).catch(sendError => console.error('Error sending error message:', sendError.message));
    }
    
    if (!res.headersSent) {
      return res.status(500).json({ 
        success: false, 
        message: 'Server error', 
        error: error.message 
      });
    }
  }
};

// ✅ Enhanced Receipt Route with in-memory serving
const receiptGenerate = async (req, res) => {
  try {
    const { filename } = req.params;
    
    // ✅ Validate filename to prevent path traversal attacks
    if (!filename || !filename.match(/^receipt-[a-zA-Z0-9_-]+\.pdf$/)) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }
    
    const filePath = path.join(receiptsDir, filename);

    // ✅ Check if file exists and read it
    const fileBuffer = await fs.readFile(filePath);

    // ✅ Set proper headers for Twilio WhatsApp compatibility
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    
    // ✅ Handle range requests for better media delivery
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileBuffer.length - 1;
      const chunksize = (end - start) + 1;
      
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileBuffer.length}`);
      res.setHeader('Content-Length', chunksize);
      res.send(fileBuffer.slice(start, end + 1));
    } else {
      res.status(200);
      res.send(fileBuffer);
    }
    
  } catch (error) {
    console.error('Error serving PDF:', error.message);
    if (error.code === 'ENOENT') {
      return res.status(404).json({ success: false, message: 'PDF not found' });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ✅ Serve receipts directory statically with proper headers
app.use('/api/receipts', express.static(receiptsDir, {
  maxAge: '1h', // Cache for 1 hour
  setHeaders: (res, filePath, stat) => {
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

// ✅ Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ✅ Cleanup old PDFs periodically (optional)
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const files = await fs.readdir(receiptsDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const file of files) {
        const filePath = path.join(receiptsDir, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old PDF: ${file}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old PDFs:', error);
    }
  }, 60 * 60 * 1000); // Run every hour
}

// Start Server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
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
