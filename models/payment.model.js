import mongoose from "mongoose";


const PaymentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    to_user: { type: String, required: true },
    oid: { type: String, required: true },
    message: { type: String },
    amount: { type: Number, required: true },
    upiId: { type: String, default: "N/A" },
    transactionId: { type: String, unique: true, required: true },
    razorpayPaymentId: { type: String }, // New field for Razorpay payment_id
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    done: { type: Boolean, default: false },
});

export default mongoose.model("Payment", PaymentSchema);