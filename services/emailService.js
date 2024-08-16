const nodemailer = require('nodemailer');
// SMTP transporter configuration
let transporter = nodemailer.createTransport({
    host: '1b.ncomputers.org', // Your SMTP server address
    port: 587, // Common port for SMTP submission
    secure: false, // True for 465, false for other ports
    auth: {
        user: 'sales@supplystacker.com', // Your SMTP username
        pass: 'supplystacker', // Your SMTP password
    },
    tls: {
        // Do not fail on invalid certs if your server uses self-signed certificates
        rejectUnauthorized: false
    }
});

function sendOrderConfirmationWithInvoice(email, orderDetails, filePath) {
    const mailOptions = {
        from: 'sales@supplystacker.com',
        to: email,
        subject: 'Order Confirmation',
        text: 'Here is your invoice.',
        attachments: [
            {
                filename: `invoice-${orderDetails.invoiceNumber}.pdf`,
                path: filePath,
            },
        ],
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Email send error:', error);
        } else {
            console.log('Email sent:', info.response);
        }
    });
}

function sendBackupEmail(email, subject, text, filePath) {
    const mailOptions = {
        from: 'sales@supplystacker.com',
        to: email,
        subject: subject,
        text: text,
        attachments: [
            {
                filename: `data.json`,
                path: filePath,
            },
        ],
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Email send error:', error);
        } else {
            console.log('Email sent:', info.response);
        }
    });
}


module.exports = { sendOrderConfirmationWithInvoice, sendBackupEmail };
