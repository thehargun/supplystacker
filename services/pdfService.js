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

async function generateProductsPdf(productData, baseUrl, callback) {
    try {
        console.log('DEBUG 1: generateProductsPdf started');
        console.log('DEBUG 2: productData:', {
            companyName: productData.companyName,
            userId: productData.userId,
            inventoryCount: productData.inventory ? productData.inventory.length : 0,
            userPriceLevel: productData.user?.priceLevel
        });

        // Use the passed baseUrl, fallback to env or localhost
        const finalBaseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:3000';
        console.log('DEBUG 3: finalBaseUrl =', finalBaseUrl);
        console.log('DEBUG 4: NODE_ENV =', process.env.NODE_ENV);

        console.log('DEBUG 5: Launching puppeteer browser...');
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
        console.log('DEBUG 6: Browser launched successfully');

        const page = await browser.newPage();
        console.log('DEBUG 7: Page created');

        // Set viewport for better rendering
        await page.setViewport({ 
            width: 1200, 
            height: 800,
            deviceScaleFactor: 1
        });
        console.log('DEBUG 8: Viewport set');

        const pdfUrl = `${finalBaseUrl}/products-pdf/${productData.userId}`;
        console.log('DEBUG 9: PDF URL =', pdfUrl);
        
        console.log('DEBUG 10: Navigating to PDF page...');
        await page.goto(pdfUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        console.log('DEBUG 11: Navigation successful');

        const filePath = `./pdfs/products-${productData.companyName.replace(/\s+/g, '-')}.pdf`;
        console.log('DEBUG 12: File path =', filePath);

        console.log('DEBUG 13: Creating pdfs directory...');
        fs.mkdirSync('./pdfs', { recursive: true });
        console.log('DEBUG 14: Directory created');

        console.log('DEBUG 15: Generating PDF...');
        await page.pdf({
            path: filePath,
            format: 'A4',
            printBackground: false,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            margin: { 
                top: '15mm', 
                right: '15mm', 
                bottom: '15mm', 
                left: '15mm' 
            },
            tagged: false,
            outline: false
        });
        console.log('DEBUG 16: PDF generated to file');

        await browser.close();
        console.log('DEBUG 17: Browser closed');

        // Log file size for monitoring
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log('DEBUG 18: PDF file created successfully - Size:', fileSizeInMB, 'MB');
            console.log('DEBUG 19: Full file path:', path.resolve(filePath));
        } else {
            console.error('DEBUG ERROR: PDF file does not exist at', filePath);
        }

        console.log('DEBUG 20: Calling callback with filePath');
        callback(null, filePath);
        
    } catch (error) {
        console.error('DEBUG ERROR: Exception caught in generateProductsPdf');
        console.error('ERROR NAME:', error.name);
        console.error('ERROR MESSAGE:', error.message);
        console.error('ERROR STACK:', error.stack);
        console.error('FULL ERROR:', JSON.stringify(error, null, 2));
        callback(error, null);
    }
}

module.exports = { generateInvoicePdf, generateProductsPdf };