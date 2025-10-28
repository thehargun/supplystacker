const PDFDocument = require('pdfkit');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function generateInvoicePdf(orderDetails, callback) {
    const doc = new PDFDocument({ margin: 50 });
    const filePath = `./invoices/invoice-${orderDetails.invoiceNumber}.pdf`;

    fs.mkdirSync('./invoices', { recursive: true });
    doc.pipe(fs.createWriteStream(filePath));

    // Draw the image - top left
    doc.image('./public/logo.jpg', 50, 50, { width: 150 });

    // Company details - bold and regular text
    const companyInfoStartY = 130; 
    doc.fontSize(10).font('Helvetica-Bold')
       .text('Supply Stacker LLC', 50, companyInfoStartY);
    doc.fontSize(10).font('Helvetica')
       .text('35 8th Street, Ste #9', 50, companyInfoStartY + 15)
       .text('Passaic, NJ 07055', 50, companyInfoStartY + 30)
       .text('Phone: 5512241891', 50, companyInfoStartY + 45)
       .text('Email: contact@supplystacker.com', 50, companyInfoStartY + 60)
       .text('Website: www.supplystacker.com', 50, companyInfoStartY + 75);

    // Invoice title - top right
    doc.fontSize(10).font('Helvetica-Bold').text(`INVOICE ${orderDetails.invoiceNumber}`, 400, 50, { align: 'right', width: 190 });

    // Invoice Date and Number
    doc.fontSize(10).font('Helvetica-Bold').text(`${new Date(new Date(orderDetails.dateCreated).setDate(new Date(orderDetails.dateCreated).getDate())).toLocaleDateString()}`, 400, 80, { align: 'right' });

    // Bill To Section
    const billToStartY = 130;
    doc.fontSize(10).font('Helvetica-Bold')
       .text('Bill To:', 400, billToStartY, { align: 'right' })
       .font('Helvetica')
       .text(orderDetails.companyName, { align: 'right' })
       .text(orderDetails.addressLine1, { align: 'right' });
    if (orderDetails.addressLine2) {
        doc.text(orderDetails.addressLine2, { align: 'right' });
    }
    doc.text(`${orderDetails.city}, ${orderDetails.state} - ${orderDetails.zipCode}`, { align: 'right' });

    // Function to check if we need to add a new page
    function checkPageBreak(doc, currentY, addHeight) {
        if (currentY + addHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            return doc.page.margins.top;
        }
        return currentY;
    }

    // Table Header
    doc.moveDown().fontSize(12).font('Helvetica-Bold');
    let tableTop = 250;
    doc.text('Item', 50, tableTop);
    doc.text('Qty', 200, tableTop);
    doc.text('Rate', 280, tableTop);
    doc.text('Amount', 360, tableTop);

    tableTop += 15;

    // Table Body
    doc.fontSize(10).font('Helvetica');
    orderDetails.products.forEach(product => {
        // Wrap item name if too long
        const productNameWidth = 140;
        const productNameHeight = doc.heightOfString(product.productName, { width: productNameWidth });

        tableTop = checkPageBreak(doc, tableTop, productNameHeight + 5);

        doc.text(product.productName, 50, tableTop, { width: productNameWidth });

        const nextColumnY = tableTop + (productNameHeight > 15 ? productNameHeight - 15 : 0);

        doc.text(product.quantity, 200, nextColumnY, { width: 50, align: 'right' });
        doc.text(`$${product.rate.toFixed(2)}`, 280, nextColumnY, { width: 50, align: 'right' });
        doc.text(`$${(product.quantity * product.rate).toFixed(2)}`, 360, nextColumnY, { width: 50, align: 'right' });

        tableTop += productNameHeight + 5;
    });

    // Balance Due
    tableTop = checkPageBreak(doc, tableTop, 30);
    // Ensure totalBalance is defined and has a valid value
    const balanceDue = orderDetails.totalBalance ? parseFloat(orderDetails.totalBalance) : 0;
    const formattedBalanceDue = `$${balanceDue.toFixed(2)}`;

    doc.fontSize(12)
       .font('Helvetica-Bold')
       .text(`Total Including Tax: ` + formattedBalanceDue, 50, tableTop + 20);

    // Draw lines for the table
    doc.strokeColor('#000')
        .lineWidth(1)
        .moveTo(50, 245)
        .lineTo(550, 245)
        .stroke()
        .moveTo(50, tableTop + 5)
        .lineTo(550, tableTop + 5)
        .stroke();

    doc.end();
    callback(filePath);
}

async function generateProductsPdf(productData, callback) {
    try {
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions'
            ]
        });
        
        const page = await browser.newPage();
        
        // Set viewport for better rendering
        await page.setViewport({ 
            width: 1200, 
            height: 800,
            deviceScaleFactor: 1 // Reduce from default 2 to save space
        });
        
        // Navigate to the PDF page
        await page.goto(`http://localhost:3000/products-pdf/${productData.userId}`, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        const filePath = `./pdfs/products-${productData.companyName.replace(/\s+/g, '-')}.pdf`;
        fs.mkdirSync('./pdfs', { recursive: true });
        
        // Generate PDF with optimized settings for smaller file size
        await page.pdf({
            path: filePath,
            format: 'A4',
            printBackground: false, // This alone can reduce size by 30-50%
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            margin: { 
                top: '15mm', 
                right: '15mm', 
                bottom: '15mm', 
                left: '15mm' 
            },
            // Quality and compression settings
            tagged: false, // Disable accessibility tags to reduce size
            outline: false, // Disable PDF outline/bookmarks
            // Use default quality (don't specify quality to let Puppeteer optimize)
        });
        
        await browser.close();
        
        // Log file size for monitoring
        const stats = fs.statSync(filePath);
        const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`PDF generated: ${fileSizeInMB}MB - ${filePath}`);
        
        callback(filePath);
        
    } catch (error) {
        console.error('Error generating PDF:', error);
        callback(null, error);
    }
}

module.exports = { generateInvoicePdf, generateProductsPdf };