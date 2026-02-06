// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pdfService = require('./services/pdfService');
const emailService = require('./services/emailService');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const app = express();
const moment = require('moment');
const archiver = require('archiver');

// PDF Compression Utility Function with timeout and file size check
async function compressPdfFile(inputPath) {
    try {
        console.log('[PDF-COMPRESS] Starting compression for:', inputPath);
        
        const publicKey = process.env.ILOVE_PUBLIC_KEY || process.env.ILOVE_PROJECT_ID;
        if (!publicKey) {
            console.warn('[PDF-COMPRESS] No iLovePDF public key found, skipping compression');
            return inputPath;
        }

        // Skip compression for smaller files (under 20MB) or very large files (over 50MB)
        if (fs.existsSync(inputPath)) {
            const stats = fs.statSync(inputPath);
            const fileSizeInMB = stats.size / (1024 * 1024);
            console.log('[PDF-COMPRESS] File size:', fileSizeInMB.toFixed(2), 'MB');
            if (fileSizeInMB < 20) {
                console.log('[PDF-COMPRESS] File is small, skipping compression');
                return inputPath;
            }
            if (fileSizeInMB > 50) {
                console.log('[PDF-COMPRESS] File is too large for compression, skipping');
                return inputPath;
            }
        }
        
        console.log('[PDF-COMPRESS] Public key found, proceeding with compression...');

        // Proceed with compression (with timeouts)
        const result = await performCompressionAsync(inputPath, publicKey);
        return result;

    } catch (error) {
        console.error('[PDF-COMPRESS] Error during compression:', error.message);
        console.error('[PDF-COMPRESS] Stack:', error.stack);
        throw error; // Throw error instead of silently returning original
    }
}

// Helper function for actual compression logic
async function performCompressionAsync(inputPath, publicKey) {
    const timeoutMs = 60000; // 60 seconds timeout

    // 1) Auth: Get signed token
    const authController = new AbortController();
    const authTimeout = setTimeout(() => authController.abort(), timeoutMs);
    let authRes;
    try {
        authRes = await fetch("https://api.ilovepdf.com/v1/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ public_key: publicKey }),
            signal: authController.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Auth request timed out');
        throw err;
    } finally {
        clearTimeout(authTimeout);
    }
    
    if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
    const authJson = await authRes.json();
    const token = authJson.token;
    if (!token) throw new Error('No token received from auth');

    const authHeader = { Authorization: `Bearer ${token}` };

    // 2) Start: Initialize compression task
    const startController = new AbortController();
    const startTimeout = setTimeout(() => startController.abort(), timeoutMs);
    let startRes;
    try {
        startRes = await fetch("https://api.ilovepdf.com/v1/start/compress/us", {
            method: "GET",
            headers: authHeader,
            signal: startController.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Start request timed out');
        throw err;
    } finally {
        clearTimeout(startTimeout);
    }
    
    if (!startRes.ok) throw new Error(`Start failed: ${startRes.status}`);
    const startJson = await startRes.json();
    const server = startJson.server;
    const task = startJson.task;
    if (!server || !task) throw new Error('No server or task from start response');

    // 3) Upload: Send PDF file to server
    console.log('[PDF-COMPRESS] Reading file:', inputPath);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found: ${inputPath}`);
    }
    
    const fileBuf = fs.readFileSync(inputPath);
    console.log('[PDF-COMPRESS] File read successfully, size:', (fileBuf.length / (1024 * 1024)).toFixed(2), 'MB');
    
    const form = new FormData();
    form.append("task", task);
    form.append("file", new Blob([fileBuf], { type: "application/pdf" }), path.basename(inputPath));

    console.log('[PDF-COMPRESS] Uploading file to:', `https://${server}/v1/upload`);
    const uploadController = new AbortController();
    const uploadTimeout = setTimeout(() => uploadController.abort(), timeoutMs * 2); // Longer for upload
    let uploadRes;
    try {
        uploadRes = await fetch(`https://${server}/v1/upload`, {
            method: "POST",
            headers: authHeader,
            body: form,
            signal: uploadController.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Upload request timed out');
        throw err;
    } finally {
        clearTimeout(uploadTimeout);
    }
    
    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
    const uploadJson = await uploadRes.json();
    const serverFilename = uploadJson.server_filename;
    if (!serverFilename) throw new Error('No server filename from upload');
    console.log('[PDF-COMPRESS] Upload successful, server filename:', serverFilename);

    // 4) Process: Start compression
    const processBody = {
        task,
        tool: "compress",
        compression_level: "recommended",
        files: [{ server_filename: serverFilename, filename: path.basename(inputPath) }]
    };

    console.log('[PDF-COMPRESS] Processing compression...');
    const processController = new AbortController();
    const processTimeout = setTimeout(() => processController.abort(), timeoutMs);
    let processRes;
    try {
        processRes = await fetch(`https://${server}/v1/process`, {
            method: "POST",
            headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(processBody),
            signal: processController.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Process request timed out');
        throw err;
    } finally {
        clearTimeout(processTimeout);
    }
    
    if (!processRes.ok) throw new Error(`Process failed: ${processRes.status}`);
    console.log('[PDF-COMPRESS] Process completed successfully');

    // 5) Download: Get compressed PDF
    console.log('[PDF-COMPRESS] Downloading compressed file...');
    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(() => downloadController.abort(), timeoutMs);
    let downloadRes;
    try {
        downloadRes = await fetch(`https://${server}/v1/download/${task}`, {
            method: "GET",
            headers: authHeader,
            signal: downloadController.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Download request timed out');
        throw err;
    } finally {
        clearTimeout(downloadTimeout);
    }
    
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);

    // Save compressed file
    const compressedBuf = Buffer.from(await downloadRes.arrayBuffer());
    const compressedPath = inputPath.replace('.pdf', '-compressed.pdf');
    console.log('[PDF-COMPRESS] Downloaded compressed file, size:', (compressedBuf.length / (1024 * 1024)).toFixed(2), 'MB');
    
    fs.writeFileSync(compressedPath, compressedBuf);
    console.log('[PDF-COMPRESS] Compression successful, saved to:', compressedPath);
    return compressedPath;
}

let categoryRanks = {};
// Load data from data.json
console.log('Current directory:', __dirname);
let data = {};
try {
    data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
} catch (e) {
    console.log('data.json not found, starting fresh');
}
let users = data.users || []; // To include both admin and customer users
let inventory = data.inventory || [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, rank: 0, imageUrl: "/path/to/image1.jpg" },
];
let returns = data.returns || [];
let purchases = data.purchases || []
let vendors = data.vendors || [];


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: 'secret123',
    resave: true,
    saveUninitialized: true
}));

app.use((req, res, next) => {
    res.locals.req = req; // Make req available in EJS views
    next();
});

// Configure multer storage
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Update file filter to allow HEIF images
const multerUpload = multer({
    storage: storage,
    limits: { fileSize: 1000000000 }, // 1 MB
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png|gif|heic|heif/; // Add heic and heif
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Error: Only images (JPEG, PNG, GIF, HEIC, HEIF) are allowed!'));
        }
    }
});

// Check file type
function checkFileType(file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Images only!');
    }
}

function loadData() {
    try {
        const data = fs.readFileSync('data.json', 'utf8');
        const json = JSON.parse(data);

        if (json && Array.isArray(json.users) && Array.isArray(json.inventory)) {
            users = json.users;
            inventory = json.inventory;
            purchases = json.purchases;
            vendors = json.vendors || [];
            returns = json.returns || []; // Initialize returns if not present

            // Load category ranks
            if (json.ItemsCategory) {
                json.ItemsCategory.forEach(category => {
                    categoryRanks[category.Category] = category.Rank;
                });
            }
        } else {
            console.log('Data structure is not valid, not overwriting existing data.');
        }
    } catch (error) {
        console.log('Error reading data.json, starting with empty arrays.');
        returns = []; // Initialize returns array if reading fails
    }
}



loadData();
setInterval(saveData, 1000);


const adminExists = users.some(user => user.email === "admin@example.com");
if (!adminExists) {
    bcrypt.hash('adminpass', 10, function (err, hash) {
        if (err) {
            console.error("Error hashing admin password", err);
        } else {
            users.push({ id: 1, email: "admin@example.com", password: hash, role: "admin" });
        }
    });
}

function saveData() {
    try {
        // Read existing data to preserve any manual edits or extra fields
        const existingData = JSON.parse(fs.readFileSync('data.json', 'utf8'));
        const dataToSave = {
            ...existingData,
            users,
            inventory,
            purchases,
            vendors,
            returns,
            ItemsCategory: Object.keys(categoryRanks).map(category => ({
                Category: category,
                Rank: categoryRanks[category]
            }))
        };
        fs.writeFileSync('data.json', JSON.stringify(dataToSave, null, 2));
    } catch (error) {
        console.error('Error saving data:', error.message);
        console.error('Error stack:', error.stack);
    }
}




const cron = require('node-cron'); // Add this at the top of the file along with other requires

// Function to send the latest data.json file via email
function sendLatestDataJson() {
    const filePath = path.join(__dirname, 'data.json');
    emailService.sendBackupEmail('sales@supplystacker.com', 'Latest data.json file', 'Please find the latest data.json file attached.', filePath);
}

// Schedule the task to run every 10 seconds
setInterval(() => {
    sendLatestDataJson();
}, 600000);


// Routes
app.get('/', (req, res) => {
    res.render('login', { registerButton: true });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(user => user.email === email);
    if (user) {
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.user = { ...user };
            req.session.loggedIn = true;
            if (user.role === 'admin') {
                res.redirect('/admin');
            } else {
                res.redirect('/products');
            }
        } else {
            res.render('login', { errorMessage: 'Invalid credentials.' });
        }
    } else {
        res.render('login', { errorMessage: 'User not found.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.get('/admin', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('admin');
});

app.get('/admin/view-inventory', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    // Sort inventory based on category rank
    inventory.sort((a, b) => {
        const rankA = categoryRanks[a.itemCategory] || Infinity;
        const rankB = categoryRanks[b.itemCategory] || Infinity;
        return rankA - rankB;
    });

    res.render('view-inventory', { inventory });
});

app.get('/admin/add-inventory', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('add-inventory', { inventory });
});

app.post('/admin/add-inventory', multerUpload.single('image'), (req, res) => {
    if (req.file == undefined) {
        return res.send('Error: No file selected!');
    }

    let { itemName, itemCategory, otherCategory, quantity, cost, priceLevel1, priceLevel2, priceLevel3, rank, taxableItem } = req.body;
    const imageUrl = '/uploads/' + req.file.filename;

    if (itemCategory === 'Other' && otherCategory) {
        itemCategory = otherCategory;
    }

    // Find the highest existing id
    const highestId = inventory.reduce((maxId, currentItem) => {
        return currentItem.id > maxId ? currentItem.id : maxId;
    }, 0);

    // Assign new id as highest id + 1
    const newId = highestId + 1;

    inventory.push({
        id: newId,
        itemName,
        itemCategory,
        cost: parseFloat(cost),
        quantity: parseInt(quantity),
        priceLevel1: parseFloat(priceLevel1),
        priceLevel2: parseFloat(priceLevel2),
        priceLevel3: parseFloat(priceLevel3),
        rank: 0,
        imageUrl,
        taxableItem: taxableItem === 'Yes'
    });

    saveData();
    res.redirect('/admin/view-inventory');
});



app.get('/admin/edit-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const item = inventory.find(item => item.id === parseInt(req.params.id));
    res.render('edit-inventory', { item });
});

app.post('/admin/edit-inventory/:id', multerUpload.single('image'), async (req, res) => {
    const itemId = parseInt(req.params.id);
    const itemIndex = inventory.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
        return res.status(404).send('Item not found.');
    }

    // Update item properties
    const currentItem = inventory[itemIndex];
    currentItem.itemName = req.body.itemName || currentItem.itemName;
    currentItem.itemCategory = req.body.itemCategory || currentItem.itemCategory;
    currentItem.cost = req.body.cost ? parseFloat(req.body.cost) : currentItem.cost;
    currentItem.quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : currentItem.quantity;
    currentItem.priceLevel1 = req.body.priceLevel1 ? parseFloat(req.body.priceLevel1) : currentItem.priceLevel1;
    currentItem.priceLevel2 = req.body.priceLevel2 ? parseFloat(req.body.priceLevel2) : currentItem.priceLevel2;
    currentItem.priceLevel3 = req.body.priceLevel3 ? parseFloat(req.body.priceLevel3) : currentItem.priceLevel3;
    
    // Fix for taxableItem update
    currentItem.taxableItem = req.body.taxableItem === 'Yes';

    if (req.file) {
        currentItem.imageUrl = '/uploads/' + req.file.filename;
    }

    // Update inventory item and save data
    inventory[itemIndex] = currentItem;
    saveData();
    res.redirect('/admin/view-inventory');
});




app.get('/admin/delete-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    inventory = inventory.filter(item => item.id !== parseInt(req.params.id));
    res.redirect('/admin/view-inventory');
});

app.get('/admin/view-customers', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('view-customers', { customers: users });
});

app.get('/admin/add-customer', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('add-customer');
});

app.post('/admin/add-customer', async (req, res) => {
    const { email, password, company, phone, addressLine1, addressLine2, city, state, zipCode, priceLevel, taxable } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const newCustomer = {
        id: users.length + 1,
        email,
        password: hashedPassword,
        company,
        phone,
        addressLine1,
        addressLine2,
        city,
        state,
        zipCode,
        priceLevel: parseInt(priceLevel),
        taxable: taxable === 'Yes',
        role: 'customer',
        invoices: []
    };

    users.push(newCustomer);
    saveData();
    res.redirect('/admin/view-customers');
});





app.get('/products', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/');
    }
    inventory.sort((a, b) => {
        const rankA = categoryRanks[a.itemCategory] || Infinity;
        const rankB = categoryRanks[b.itemCategory] || Infinity;
        return rankA === rankB ? a.rank - b.rank : rankA - rankB;
    });
    const user = req.session.user;
    const userPriceLevel = `priceLevel${user.priceLevel}`;
    const finalPriceMultiplier = user.finalPrice || 1;

    // Adjust inventory prices based on price level, apply finalPrice multiplier, and round to nearest .00, .25, .50, .75
    const adjustedInventory = inventory.map(item => ({
        ...item,
        price: (Math.floor((item[userPriceLevel] * finalPriceMultiplier) * 4) / 4).toFixed(2)
    }));

    res.render('products', { inventory: adjustedInventory });
});




app.post('/add-to-cart', (req, res) => {
    const { itemId, quantity } = req.body;
    if (!req.session.cart) req.session.cart = [];
    const item = inventory.find(item => item.id == itemId);
    if (item) {
        const userPriceLevel = req.session.user.priceLevel || '3';
        const price = item[`priceLevel${userPriceLevel}`];

        const existingItemIndex = req.session.cart.findIndex(cartItem => cartItem.id == itemId);
        if (existingItemIndex !== -1) {
            req.session.cart[existingItemIndex].quantity += parseFloat(quantity);
        } else {
            req.session.cart.push({
                ...item,
                quantity: parseFloat(quantity),
                price
            });
        }
    }
    res.redirect('/cart');
});


app.get('/cart', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/');
    }

    let cart = req.session.cart || [];
    let user = req.session.user;

    // Calculate subtotal and tax
    let subtotal = 0;
    let salesTax = 0;

    cart.forEach(item => {
        let itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

        // Apply tax only if the user is taxable and the item is taxable
        if (user.taxable && item.taxableItem) {
            salesTax += itemTotal * 0.06625; // 6.625% tax
        }
    });

    // Calculate total amount including sales tax
    let totalAmount = subtotal + salesTax;

    res.render('cart', {
        cart: cart,
        subtotal: subtotal.toFixed(2),
        salesTax: salesTax.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        userTaxable: user.taxable // Pass user's taxable status to the template
    });
});
// Add this route after your existing customer routes (around line 400-500)
app.post('/admin/delete-customer/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const customerId = parseInt(req.params.id);
    
    // Find the index of the customer to delete
    const customerIndex = users.findIndex(user => user.id === customerId);
    
    if (customerIndex === -1) {
        return res.status(404).send('Customer not found.');
    }
    
    // Remove the customer from the users array
    users.splice(customerIndex, 1);
    
    // Save the updated data
    saveData();
    
    // Redirect back to the customers view
    res.redirect('/admin/view-customers');
});


app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { email, password, company, phone, addressLine1, addressLine2, city, state, zipCode } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
        id: users.length + 1,
        email,
        password: hashedPassword,
        company,
        phone,
        addressLine1,
        addressLine2,
        city,
        state,
        zipCode,
        role: 'customer',
        priceLevel: 3,
        invoices: [],
        lastInvoiceNumber: 0
    };

    users.push(newUser);
    res.redirect('/');
});

app.get('/admin/edit-customer/:id', (req, res) => {
    const customerId = parseInt(req.params.id);
    const customer = users.find(user => user.id === customerId);
    if (!customer) {
        return res.send('Customer not found.');
    }
    res.render('edit-customer', { customer });
});

app.post('/admin/edit-customer/:id', async (req, res) => {
    const customerId = parseInt(req.params.id);
    const customerIndex = users.findIndex(user => user.id === customerId);

    if (customerIndex === -1) {
        return res.status(404).send('Customer not found.');
    }

    // Update customer details
    users[customerIndex].email = req.body.email;
    users[customerIndex].company = req.body.company;
    users[customerIndex].phone = req.body.phone;
    users[customerIndex].addressLine1 = req.body.addressLine1;
    users[customerIndex].addressLine2 = req.body.addressLine2;
    users[customerIndex].city = req.body.city;
    users[customerIndex].state = req.body.state;
    users[customerIndex].zipCode = req.body.zipCode;
    users[customerIndex].priceLevel = parseInt(req.body.priceLevel);
    users[customerIndex].taxable = req.body.taxable === 'Yes';

    saveData();
    res.redirect('/admin/view-customers');
});

// Add this route for the main invoices listing page
app.get('/admin/invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    // Collect all invoices from all users
    let allInvoices = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            allInvoices = allInvoices.concat(user.invoices);
        }
    });

    // Helper function to parse invoice numbers for proper sorting
    const parseInvoiceNumber = (invoiceNumber) => {
        const match = invoiceNumber.match(/([A-Za-z]+)(\d+)/);
        return match ? { prefix: match[1], number: parseInt(match[2], 10) } : { prefix: invoiceNumber, number: 0 };
    };

    // Sort invoices by invoice number (ascending order)
    allInvoices.sort((a, b) => {
        const parsedA = parseInvoiceNumber(a.invoiceNumber);
        const parsedB = parseInvoiceNumber(b.invoiceNumber);
        
        // First compare by prefix (alphabetically)
        if (parsedA.prefix !== parsedB.prefix) {
            return parsedA.prefix.localeCompare(parsedB.prefix);
        }
        
        // If prefixes are the same, compare by number
        return parsedA.number - parsedB.number;
    });

    res.render('invoices', { invoices: allInvoices });
});

// Route to render invoice details page
app.get('/admin/invoices/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceDetails = null;

    // Load users and inventory from data.json
    fs.readFile('./data.json', 'utf8', (err, data) => {
        if (err) {
            console.error("Error reading data.json:", err);
            return res.status(500).send('Error reading data.');
        }

        let users, inventory;

        try {
            const jsonData = JSON.parse(data);
            users = jsonData.users;
            inventory = jsonData.inventory;
        } catch (parseError) {
            console.error("Error parsing JSON:", parseError);
            return res.status(500).send('Data format error.');
        }

        // Find the requested invoice and customer price level
        let customerPriceLevel = null;
        users.forEach(user => {
            if (user.invoices && user.invoices.length > 0) {
                const invoice = user.invoices.find(inv => inv.invoiceNumber === invoiceNumber);
                if (invoice) {
                    invoiceDetails = invoice;
                    customerPriceLevel = user.priceLevel;  // Get the price level of the customer
                }
            }
        });

        if (!invoiceDetails) {
            return res.status(404).send('Invoice not found.');
        }

        // Pass the invoice details, inventory (available products), and customer price level to the template
        res.render('invoice-details', {
            invoice: invoiceDetails,
            availableProducts: inventory,
            customerPriceLevel: customerPriceLevel
        });
    });
});


app.post('/admin/invoices/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    console.log("Received data for updating invoice:", req.body);

    const oldInvoiceNumber = req.params.invoiceNumber;
    const newInvoiceNumber = req.body.invoiceNumber;
    const updatedNote = req.body.notes;

    let userIndex = null;
    let invoiceIndex = null;

    users.forEach((user, uIndex) => {
        if (user.invoices && user.invoices.length > 0) {
            const foundInvoiceIndex = user.invoices.findIndex(inv => inv.invoiceNumber === oldInvoiceNumber);
            if (foundInvoiceIndex !== -1) {
                userIndex = uIndex;
                invoiceIndex = foundInvoiceIndex;
            }
        }
    });

    if (userIndex === null || invoiceIndex === null) {
        console.error("Invoice not found.");
        return res.status(404).send('Invoice not found.');
    }

    // Log products for validation debugging
    if (!req.body.products || !Array.isArray(req.body.products)) {
        console.error("Invalid product data format. Products should be an array:", req.body.products);
        return res.status(400).send('Invalid product data format.');
    }

    req.body.products.forEach((product, index) => {
        if (
            !product.productName ||
            typeof product.productName !== 'string' ||
            typeof product.productCategory !== 'string' ||
            typeof product.quantity !== 'number' ||
            typeof product.rate !== 'number' ||
            typeof product.total !== 'number'
        ) {
            console.error(`Invalid product at index ${index}:`, product);
            return res.status(400).send(`Invalid product data format at index ${index}.`);
        }
    });

    // Update invoice details
    try {
        users[userIndex].invoices[invoiceIndex] = {
            ...users[userIndex].invoices[invoiceIndex],
            ...req.body, // Spread new updates
            CashPayment: parseFloat(req.body.CashPayment) || 0,
            AccountPayment: parseFloat(req.body.AccountPayment) || 0,
            notes: req.body.notes,
            salesTax: parseFloat(req.body.salesTax) || 0,
            subtotal: parseFloat(req.body.subtotal) || 0,
            totalAmount: parseFloat(req.body.totalAmount) || 0,
            totalBalance: parseFloat(req.body.totalBalance) || 0,
            paid: req.body.totalBalance === 0
        };

        saveData(); // Save changes to data.json
        console.log("Invoice updated successfully:", users[userIndex].invoices[invoiceIndex]);

        // Redirect to the new invoice number page instead of sending JSON
        res.redirect(`/admin/invoices/${newInvoiceNumber}`);
    } catch (error) {
        console.error("Error updating invoice:", error);
        res.status(500).send("An error occurred while updating the invoice.");
    }
});


app.get('/admin/invoices/delete/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceFound = false;
    let deletedInvoice = null;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            const invoiceIndex = user.invoices.findIndex(inv => inv.invoiceNumber === invoiceNumber);
            if (invoiceIndex !== -1) {
                deletedInvoice = user.invoices[invoiceIndex];
                user.invoices.splice(invoiceIndex, 1);
                invoiceFound = true;
            }
        }
    });

    if (!invoiceFound) {
        return res.status(404).send('Invoice not found.');
    }

    // Reverse inventory quantities for each product in the deleted invoice
    if (deletedInvoice && deletedInvoice.products) {
        console.log('[INVENTORY REVERSAL] Reversing inventory for deleted invoice:', invoiceNumber);
        deletedInvoice.products.forEach(product => {
            const inventoryItem = inventory.find(item => item.itemName === product.productName);
            if (inventoryItem) {
                const oldQty = inventoryItem.quantity || 0;
                // Add back positive quantities, subtract negative quantities
                inventoryItem.quantity = oldQty + product.quantity;
                console.log('[INVENTORY REVERSAL] Item:', product.productName, 'Qty on invoice:', product.quantity, 'Old stock:', oldQty, 'New stock:', inventoryItem.quantity);
            } else {
                console.log('[INVENTORY REVERSAL] WARNING: Could not find inventory item for:', product.productName);
            }
        });
        console.log('[INVENTORY REVERSAL] Completed.');
    }

    // Save updated data to data.json
    saveData();

    // Redirect to the specified URL or default to /admin/invoices
    const redirectUrl = req.query.redirect || '/admin/invoices';
    res.redirect(redirectUrl);
});
// Route to handle invoice printing from admin panel
app.post('/admin/invoices/print/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    try {
        const invoiceDetails = req.body;
        
        // Generate PDF
        pdfService.generateInvoicePdf(invoiceDetails, (filePath) => {
            if (filePath) {
                // Send email with PDF attachment
                try {
                    emailService.sendOrderConfirmationWithInvoice(
                        invoiceDetails.companyName, 
                        invoiceDetails, 
                        filePath
                    );
                    console.log('Invoice PDF generated and emailed successfully');
                } catch (emailError) {
                    console.error('Email sending failed:', emailError);
                    // Continue anyway - don't fail the request for email issues
                }
                
                res.json({ 
                    success: true, 
                    message: 'Invoice PDF generated and emailed successfully',
                    pdfUrl: `/download-invoice/${invoiceDetails.invoiceNumber}`
                });
            } else {
                res.status(500).json({ 
                    success: false, 
                    message: 'Failed to generate PDF' 
                });
            }
        });
    } catch (error) {
        console.error('Error in invoice printing:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error processing invoice: ' + error.message 
        });
    }
});

app.get('/admin/manage-payment/invoices/delete/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceFound = false;
    let deletedInvoice = null;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            const invoiceIndex = user.invoices.findIndex(inv => inv.invoiceNumber === invoiceNumber);
            if (invoiceIndex !== -1) {
                deletedInvoice = user.invoices[invoiceIndex];
                user.invoices.splice(invoiceIndex, 1);
                invoiceFound = true;
            }
        }
    });

    if (!invoiceFound) {
        return res.status(404).send('Invoice not found.');
    }

    // Reverse inventory quantities for each product in the deleted invoice
    if (deletedInvoice && deletedInvoice.products) {
        console.log('[INVENTORY REVERSAL] Reversing inventory for deleted invoice:', invoiceNumber);
        deletedInvoice.products.forEach(product => {
            const inventoryItem = inventory.find(item => item.itemName === product.productName);
            if (inventoryItem) {
                const oldQty = inventoryItem.quantity || 0;
                // Add back positive quantities, subtract negative quantities
                inventoryItem.quantity = oldQty + product.quantity;
                console.log('[INVENTORY REVERSAL] Item:', product.productName, 'Qty on invoice:', product.quantity, 'Old stock:', oldQty, 'New stock:', inventoryItem.quantity);
            } else {
                console.log('[INVENTORY REVERSAL] WARNING: Could not find inventory item for:', product.productName);
            }
        });
        console.log('[INVENTORY REVERSAL] Completed.');
    }

    // Save updated data to data.json
    saveData();

    res.redirect('/admin/manage-payment');
});

app.delete('/remove-from-cart/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    if (!req.session.cart || !req.session.cart.length) {
        return res.status(400).send('Cart is empty.');
    }

    req.session.cart = req.session.cart.filter(item => item.id !== itemId);
    res.sendStatus(204);
});
function parseInvoiceNumber(invoiceNumber) {
    if (!invoiceNumber) {
        return { prefix: '', number: 0 };
    }
    
    // Match pattern like "AWL001", "BWL123", etc.
    const match = invoiceNumber.match(/^([A-Za-z]+)(\d+)$/);
    
    if (match) {
        return {
            prefix: match[1],
            number: parseInt(match[2], 10)
        };
    }
    
    // If no match, try to extract any numbers
    const numericMatch = invoiceNumber.match(/\d+/);
    if (numericMatch) {
        return {
            prefix: invoiceNumber.replace(/\d+/, ''),
            number: parseInt(numericMatch[0], 10)
        };
    }
    
    // Default fallback
    return { prefix: invoiceNumber, number: 0 };
}



app.get('/get-total-amount', (req, res) => {
    const totalAmount = req.session.cart.reduce((total, item) => total + (item.price * item.quantity), 0);
    res.json({ totalAmount });
});

function generateInvoiceNumber(company) {
    try {
        // Check if company is defined
        if (!company || typeof company !== 'string') {
            console.error('Invalid company name provided to generateInvoiceNumber:', company);
            // Return a default invoice number with timestamp
            return `INV${Date.now().toString().slice(-6)}`;
        }

        // Locate the user by company name
        const user = users.find(user => user.company === company);
        if (!user) {
            console.error('User company information is missing for:', company);
            // Return a fallback invoice number
            const initials = company.split(' ').map(word => word[0]).join('').toUpperCase();
            return `${initials}01`;
        }

        // Extract invoices for the user
        const userInvoices = user.invoices || [];

        if (userInvoices.length === 0) {
            // If no invoices exist, start with 01
            const initials = company.split(' ').map(word => word[0]).join('').toUpperCase();
            return `${initials}01`;
        }

        // Extract the highest invoice number from user's invoices
        const invoiceNumbers = userInvoices.map(inv => {
            const { prefix, number } = parseInvoiceNumber(inv.invoiceNumber);
            return { prefix, number };
        });

        const companyInitials = company.split(' ').map(word => word[0]).join('').toUpperCase();
        let highestNumber = 0;

        // Find the highest number for the same prefix
        invoiceNumbers.forEach(inv => {
            if (inv.prefix === companyInitials && inv.number > highestNumber) {
                highestNumber = inv.number;
            }
        });

        // Generate the next invoice number
        const newInvoiceNumber = `${companyInitials}${String(highestNumber + 1).padStart(2, '0')}`;
        return newInvoiceNumber;
        
    } catch (error) {
        console.error('Error in generateInvoiceNumber:', error);
        // Return a safe fallback invoice number
        return `ERR${Date.now().toString().slice(-6)}`;
    }
}


app.get('/cart', (req, res) => {
    console.log('=== CART DEBUG START ===');
    
    if (!req.session.loggedIn) {
        console.log('User not logged in');
        return res.send('Please log in.');
    }

    console.log('User logged in:', req.session.user.email);
    
    let cart = req.session.cart || [];
    let user = req.session.user;

    console.log('Cart contents:', JSON.stringify(cart, null, 2));
    console.log('User taxable status:', user.taxable);
    console.log('Cart length:', cart.length);

    // Debug each cart item
    cart.forEach((item, index) => {
        console.log(`Cart item ${index}:`, {
            id: item.id,
            itemName: item.itemName,
            quantity: item.quantity,
            price: item.price,
            taxableItem: item.taxableItem
        });
    });

    console.log('=== CART DEBUG END ===');

    res.render('cart', {
        cart: cart,
        userTaxable: user.taxable || false
    });
});

app.post('/update-cart', (req, res) => {
    console.log('=== UPDATE CART DEBUG START ===');
    console.log('Request body:', req.body);
    
    if (!req.session.cart) {
        req.session.cart = [];
    }

    const { itemId, quantity } = req.body;
    console.log('Item ID to update:', itemId);
    console.log('New quantity:', quantity);
    console.log('Current cart before update:', JSON.stringify(req.session.cart, null, 2));

    // Find the item in the cart and update its quantity
    const itemIndex = req.session.cart.findIndex(item => item.id == itemId);
    console.log('Found item at index:', itemIndex);
    
    if (itemIndex !== -1) {
        console.log('Item found, updating quantity from', req.session.cart[itemIndex].quantity, 'to', parseFloat(quantity));
        req.session.cart[itemIndex].quantity = parseFloat(quantity);
        console.log('Cart after update:', JSON.stringify(req.session.cart, null, 2));

        // Send success response
        res.json({
            success: true,
            message: 'Cart updated successfully'
        });
    } else {
        console.log('Item not found in cart');
        res.status(404).json({ success: false, message: 'Item not found in cart.' });
    }
    
    console.log('=== UPDATE CART DEBUG END ===');
});

app.post('/delete-cart-item', (req, res) => {
    console.log('=== DELETE CART ITEM DEBUG START ===');
    console.log('Request body:', req.body);
    
    if (!req.session.cart) {
        req.session.cart = [];
    }

    const { itemId } = req.body;
    console.log('Item ID to delete:', itemId);
    console.log('Current cart before deletion:', JSON.stringify(req.session.cart, null, 2));

    // Remove the item from the cart
    const originalLength = req.session.cart.length;
    req.session.cart = req.session.cart.filter(item => {
        console.log('Comparing item.id:', item.id, 'with itemId:', itemId, 'Equal?', item.id == itemId);
        return item.id != itemId;
    });

    console.log('Cart after deletion:', JSON.stringify(req.session.cart, null, 2));
    console.log('Original length:', originalLength, 'New length:', req.session.cart.length);

    if (req.session.cart.length < originalLength) {
        console.log('Item successfully removed');
        res.json({
            success: true,
            message: 'Item removed from cart'
        });
    } else {
        console.log('Item was not found/removed');
        res.status(404).json({ success: false, message: 'Item not found in cart.' });
    }
    
    console.log('=== DELETE CART ITEM DEBUG END ===');
});











app.post('/checkout', async (req, res) => {
    try {
        if (!req.session.cart || !req.session.user) {
            console.error('Checkout failed: No items in cart or user not logged in');
            return res.redirect('/cart');
        }

        let user = req.session.user;

        // Validate user has required properties
        if (!user.company) {
            console.error('Checkout failed: User missing company information', user);
            return res.status(400).render('error', { 
                message: 'Your account is missing company information. Please contact support.' 
            });
        }

        // Generate the next invoice number using the generateInvoiceNumber function
        const invoiceNumber = generateInvoiceNumber(user.company);

        // Calculate subtotal, sales tax, and total
        let subtotal = 0;
        let salesTax = 0;

        req.session.cart.forEach(item => {
            let itemTotal = item.price * item.quantity;
            subtotal += itemTotal;

            // If the user is taxable and the item is taxable, calculate the sales tax
            if (user.taxable && item.taxableItem) {
                salesTax += itemTotal * 0.06625; // 6.625% tax
            }
        });

        let totalAmount = subtotal + salesTax;

        // Create the invoice details, ensuring all values are numbers, not strings
        const invoiceDetails = {
            invoiceNumber,
            companyName: user.company || 'Unknown Company',
            addressLine1: user.addressLine1 || '',
            addressLine2: user.addressLine2 || '',
            city: user.city || '',
            state: user.state || '',
            zipCode: user.zipCode || '',
            dateCreated: new Date().toISOString().split('T')[0],
            products: req.session.cart.map(item => ({
                productName: item.itemName || 'Unknown Product',
                productCategory: item.itemCategory || 'Unknown Category',
                quantity: item.quantity || 0,
                rate: item.price || 0,
                total: (item.quantity || 0) * (item.price || 0)
            })),
            subtotal: subtotal,
            salesTax: salesTax,
            totalAmount: totalAmount,
            totalBalance: totalAmount,
            paid: false,
            CashPayment: 0,
            AccountPayment: 0
        };

        // Push the new invoice to the user's invoice list
        if (!user.invoices) {
            user.invoices = [];
        }
        user.invoices.push(invoiceDetails);

        // Update the users array with the modified user object
        const userIndex = users.findIndex(u => u.id === user.id);
        if (userIndex !== -1) {
            users[userIndex] = user;
        } else {
            console.error("User not found in users array during checkout");
            return res.status(404).render('error', { 
                message: 'User account error. Please try logging in again.' 
            });
        }

        // Update session user data to reflect the new invoice
        req.session.user = user;

        // Deduct inventory quantities for each item in the cart
        console.log('[INVENTORY DEDUCTION] Starting inventory deduction...');
        req.session.cart.forEach(cartItem => {
            console.log('[INVENTORY DEDUCTION] Cart item:', cartItem.itemName, 'Qty ordered:', cartItem.quantity);
            const inventoryItem = inventory.find(item => item.itemName === cartItem.itemName);
            if (inventoryItem) {
                const oldQty = inventoryItem.quantity || 0;
                inventoryItem.quantity = Math.max(0, oldQty - cartItem.quantity);
                console.log('[INVENTORY DEDUCTION] Found inventory item:', inventoryItem.itemName, 'Old qty:', oldQty, 'New qty:', inventoryItem.quantity);
            } else {
                console.log('[INVENTORY DEDUCTION] WARNING: Could not find inventory item for:', cartItem.itemName);
            }
        });
        console.log('[INVENTORY DEDUCTION] Completed.');

        // Save data to data.json
        saveData();

        // Generate PDF and send email
        pdfService.generateInvoicePdf(invoiceDetails, (filePath) => {
            try {
                // Send email with PDF attachment
                emailService.sendOrderConfirmationWithInvoice(invoiceDetails.companyName, invoiceDetails, filePath);
            } catch (emailError) {
                console.error('Email sending failed:', emailError);
                // Continue anyway - don't fail checkout for email issues
            }
            
            // Clear the cart after checkout
            req.session.cart = [];

            // Render the order submission page with invoice details and PDF info
            res.render('order-submitted', { 
                invoice: invoiceDetails,
                pdfUrl: `/download-invoice/${invoiceDetails.invoiceNumber}`
            });
        });

    } catch (error) {
        console.error('Checkout process failed:', error);
        res.status(500).render('error', { 
            message: 'Checkout failed. Please try again or contact support.' 
        });
    }
});

// Add this route after your existing routes
app.get('/download-invoice/:invoiceNumber', (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    const filePath = `./invoices/invoice-${invoiceNumber}.pdf`;
    
    // Check if file exists
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=' + `invoice-${invoiceNumber}.pdf`);
        
        // Stream the PDF file to the response
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
    } else {
        res.status(404).send('PDF not found.');
    }
});
// Add this GET route for displaying the checkout page
app.get('/checkout', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/');
    }

    if (!req.session.cart || req.session.cart.length === 0) {
        return res.redirect('/cart');
    }

    let cart = req.session.cart;
    let user = req.session.user;

    // Calculate totals for display
    let subtotal = 0;
    let salesTax = 0;

    cart.forEach(item => {
        let itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

        // Apply tax if both user and item are taxable
        if (user.taxable && item.taxableItem) {
            salesTax += itemTotal * 0.06625; // 6.625% tax
        }
    });

    let totalAmount = subtotal + salesTax;

    res.render('checkout', {
        cart: cart,
        user: user,
        subtotal: subtotal,
        salesTax: salesTax,
        totalAmount: totalAmount
    });
});




app.post('/submit-order', async (req, res) => {
    console.log('==== /submit-order ROUTE HIT ====');
    if (!req.session.cart || !req.session.user) {
        return res.send('No items in cart or user not logged in.');
    }

    // Extract the user object from the session
    let user = req.session.user;

    // Ensure that user.invoices is properly initialized as an array
    if (!user.invoices) {
        console.error("User invoices not found, initializing to an empty array.");
        user.invoices = [];
    } else if (!Array.isArray(user.invoices)) {
        console.error("User invoices is not an array, initializing to an empty array.");
        user.invoices = [];
    }

    try {
        // Generate the next invoice number using the generateInvoiceNumber function
        const invoiceNumber = generateInvoiceNumber(user.company);

        // Debugging to see the generated invoice number

        const invoiceDetails = {
            invoiceNumber,
            companyName: user.company,
            addressLine1: user.addressLine1,
            addressLine2: user.addressLine2,
            city: user.city,
            state: user.state,
            zipCode: user.zipCode,
            dateCreated: new Date().toISOString().split('T')[0],
            products: req.session.cart.map(item => ({
                productName: item.itemName,
                productCategory: item.itemCategory,
                quantity: item.quantity,
                rate: item.price,
                total: item.quantity * item.price
            })),
            totalBalance: req.session.cart.reduce((acc, item) => acc + (item.price * item.quantity), 0),
            paid: false,
            invoiceTotal: req.session.cart.reduce((acc, item) => acc + (item.price * item.quantity), 0)
        };

        // Push the new invoice to the user's invoice list
        user.invoices.push(invoiceDetails);

        // Deduct inventory quantities for each item in the cart
        console.log('[INVENTORY DEDUCTION] Starting inventory deduction...');
        req.session.cart.forEach(cartItem => {
            console.log('[INVENTORY DEDUCTION] Cart item:', cartItem.itemName, 'Qty ordered:', cartItem.quantity);
            const inventoryItem = inventory.find(item => item.itemName === cartItem.itemName);
            if (inventoryItem) {
                const oldQty = inventoryItem.quantity || 0;
                inventoryItem.quantity = Math.max(0, oldQty - cartItem.quantity);
                console.log('[INVENTORY DEDUCTION] Found inventory item:', inventoryItem.itemName, 'Old qty:', oldQty, 'New qty:', inventoryItem.quantity);
            } else {
                console.log('[INVENTORY DEDUCTION] WARNING: Could not find inventory item for:', cartItem.itemName);
            }
        });
        console.log('[INVENTORY DEDUCTION] Completed.');

        // Update the users array with the modified user object
        const userIndex = users.findIndex(u => u.id === user.id);
        if (userIndex !== -1) {
            users[userIndex] = user;
        } else {
            console.error("User not found in users array.");
            return res.status(404).send('User not found.');
        }

        // Update session user data to reflect the new invoice
        req.session.user = user;

        // Generate PDF and send confirmation email
        pdfService.generateInvoicePdf(invoiceDetails, pdfFilePath => {
            emailService.sendOrderConfirmationWithInvoice('sales@supplystacker.com', invoiceDetails, pdfFilePath);

            // Clear the cart after successful order submission
            req.session.cart = [];

            // Render the order submission page
            res.render('order-submitted', { message: 'Order submitted successfully. Thank you!' });
        });
    } catch (error) {
        console.error('Error generating invoice number:', error.message);
        res.status(500).send('Error generating invoice number. Please try again.');
    }
});

app.get('/admin/customer-invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    // Get all invoices
    let allInvoices = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            allInvoices = allInvoices.concat(user.invoices);
        }
    });

    // Sort the invoices by invoice number alphabetically (A-Z)
    allInvoices.sort((a, b) => {
        return a.invoiceNumber.localeCompare(b.invoiceNumber);
    });

    res.render('customer-invoices', { invoices: allInvoices });
});


app.get('/admin/customer-invoices/:customerId', (req, res) => {
    const customerId = parseInt(req.params.customerId);

    const customer = users.find(user => user.id === customerId);

    if (!customer) {
        return res.send('Customer not found.');
    }

    if (!customer.invoices || customer.invoices.length === 0) {
        return res.send('No invoices for the company.');
    }

    res.render('customer-invoices', { invoices: customer.invoices });
});
app.post('/admin/duplicate-inventory/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const item = inventory.find(item => item.id === itemId);

    if (!item) {
        return res.status(404).send('Item not found.');
    }

    // Find the highest existing id
    const highestId = inventory.reduce((maxId, currentItem) => {
        return currentItem.id > maxId ? currentItem.id : maxId;
    }, 0);

    // Assign new id as highest id + 1
    const newItem = { ...item, id: highestId + 1 };
    inventory.push(newItem);

    saveData();

    res.redirect(`/admin/edit-inventory/${newItem.id}`);
});

app.post('/admin/update-inventory-order', (req, res) => {
    const updatedOrder = req.body;

    // Assuming inventory items have unique IDs and the 'rank' field determines their order
    updatedOrder.forEach(item => {
        const inventoryItem = inventory.find(invItem => invItem.id === parseInt(item.id));
        if (inventoryItem) {
            inventoryItem.rank = item.rank;
        }
    });

    // Sort inventory again after updating ranks
    inventory.sort((a, b) => a.rank - b.rank);

    // Save the updated inventory order
    saveData();

    res.json({ success: true });
});

// API endpoint to update inventory quantity inline
app.post('/admin/update-inventory-quantity', (req, res) => {
    const { id, quantity } = req.body;
    const itemIndex = inventory.findIndex(item => item.id === parseInt(id));
    
    if (itemIndex === -1) {
        return res.status(404).json({ success: false, message: 'Item not found' });
    }
    
    inventory[itemIndex].quantity = parseInt(quantity) || 0;
    saveData();
    
    res.json({ success: true, quantity: inventory[itemIndex].quantity });
});

// API endpoint to update inventory cost inline
app.post('/admin/update-inventory-cost', (req, res) => {
    const { id, cost } = req.body;
    const itemIndex = inventory.findIndex(item => item.id === parseInt(id));
    
    if (itemIndex === -1) {
        return res.status(404).json({ success: false, message: 'Item not found' });
    }
    
    inventory[itemIndex].cost = parseFloat(cost) || 0;
    saveData();
    
    res.json({ success: true, cost: inventory[itemIndex].cost });
});

app.post('/admin/add-vendor/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const itemIndex = inventory.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
        return res.status(404).send({ success: false, message: 'Item not found.' });
    }

    const { vendorName, vendorPrice } = req.body;
    let { vendorIndex } = req.body;
    vendorIndex = parseInt(vendorIndex);

    if (!inventory[itemIndex].vendors) {
        inventory[itemIndex].vendors = [];
    }

    // Check if the vendor name already exists
    const existingVendorIndex = inventory[itemIndex].vendors.findIndex(vendor => vendor.name.toLowerCase() === vendorName.toLowerCase());

    if (existingVendorIndex >= 0) {
        // Vendor name exists, update the price
        inventory[itemIndex].vendors[existingVendorIndex].price = parseFloat(vendorPrice);
    } else if (vendorIndex >= 0 && vendorIndex < inventory[itemIndex].vendors.length) {
        // Edit existing vendor by index
        inventory[itemIndex].vendors[vendorIndex] = { name: vendorName, price: parseFloat(vendorPrice) };
    } else {
        // Add new vendor
        inventory[itemIndex].vendors.push({ name: vendorName, price: parseFloat(vendorPrice) });
    }

    saveData();  // Save the updated data to data.json

    res.json({ success: true });
});

app.post('/admin/remove-vendor/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const { vendorName } = req.body;

    // Find the item in the inventory
    const itemIndex = inventory.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
        return res.status(404).send('Item not found');
    }

    // Remove the vendor with the specified name
    const currentItem = inventory[itemIndex];
    currentItem.vendors = currentItem.vendors.filter(vendor => vendor.name.trim() !== vendorName.trim());

    // Save the updated inventory to data.json
    saveData();

    res.status(200).send({ success: true });
});

app.get('/admin/purchases', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const vendors = data.vendors || [];
    res.render('purchases', { inventory, vendors });
});

function roundToNearestQuarter(value) {
    return (Math.round(value * 4) / 4).toFixed(2);
}

function autoPriceRetail(cost) {
    return {
        priceLevel1: roundToNearestQuarter(1.1 * cost + 0.25),
        priceLevel2: roundToNearestQuarter(1.15 * cost + 0.5),
        priceLevel3: roundToNearestQuarter(1.3 * cost + 1)
    };
}

function vPackAutoPrice(cost) {
    return {
        priceLevel1: roundToNearestQuarter(1.15 * cost + 0.25),
        priceLevel2: roundToNearestQuarter(1.25 * cost + 0.5),
        priceLevel3: roundToNearestQuarter(1.45 * cost + 1)
    };
}

app.post('/admin/purchases', (req, res) => {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    vendors = data.vendors || [];
    purchases = data.purchases || [];
    inventory = data.inventory || [];
    users = data.users || [];
    let { vendor: vendorName, newVendor, dateCreated, invoiceNumber, cashPaid, accountPaid, paid } = req.body;
    const products = JSON.parse(req.body.products || '[]');

    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).send('No products provided.');
    }

    // Check if a new vendor is being added
    if (vendorName === 'other' && newVendor) {
        vendorName = newVendor;
        // Add the new vendor to the vendor list if not already there
        if (!vendors.includes(newVendor)) {
            vendors.push(newVendor);
            saveData();
        }
    }

    products.forEach(product => {
        const itemIndex = inventory.findIndex(item => item.itemName === product.productName);
    
        if (itemIndex >= 0) {
            inventory[itemIndex].cost = parseFloat(product.rate);
    
            if (product.autoPricing === 'autoPriceRetail') {
                const newPrices = autoPriceRetail(product.rate);
                inventory[itemIndex].priceLevel1 = parseFloat(newPrices.priceLevel1);
                inventory[itemIndex].priceLevel2 = parseFloat(newPrices.priceLevel2);
                inventory[itemIndex].priceLevel3 = parseFloat(newPrices.priceLevel3);
            } else if (product.autoPricing === 'vPackAutoPrice') {
                const newPrices = vPackAutoPrice(product.rate);
                inventory[itemIndex].priceLevel1 = parseFloat(newPrices.priceLevel1);
                inventory[itemIndex].priceLevel2 = parseFloat(newPrices.priceLevel2);
                inventory[itemIndex].priceLevel3 = parseFloat(newPrices.priceLevel3);
            }
    
            // Ensure vendors is an array
            if (!inventory[itemIndex].vendors) {
                inventory[itemIndex].vendors = [];
            }
    
            // Check if vendor already exists
            const vendorIndex = inventory[itemIndex].vendors.findIndex(vendor => vendor.name.toLowerCase() === vendorName.toLowerCase());
            if (vendorIndex >= 0) {
                // Update existing vendor
                inventory[itemIndex].vendors[vendorIndex].price = parseFloat(product.rate);
                inventory[itemIndex].vendors[vendorIndex].lastPurchased = dateCreated;
            } else {
                // Add new vendor
                inventory[itemIndex].vendors.push({ name: vendorName, price: parseFloat(product.rate), lastPurchased: dateCreated });
            }
        } else {
            console.error('Item not found in inventory:', product.productName);
        }
    });

    const invoiceTotal = products.reduce((sum, product) => sum + product.total, 0);
    const accountBalance = invoiceTotal - parseFloat(cashPaid) - parseFloat(accountPaid);

    const purchaseInvoice = {
        vendorName,
        dateCreated: new Date(dateCreated).toLocaleDateString('en-US'),
        invoiceNumber,
        cashPaid: parseFloat(cashPaid),
        accountPaid: parseFloat(accountPaid),
        invoiceTotal,
        accountBalance,
        paid: accountBalance === 0,
        products: products
    };

    // Handling purchases array
    let purchaseID = purchases ? purchases.length + 1 : 1;

    const newPurchase = {
        PurchaseID: purchaseID,
        vendorName,
        dateCreated: new Date(dateCreated).toLocaleDateString('en-US'),
        invoiceNumber,
        cashPaid: parseFloat(cashPaid),
        accountPaid: parseFloat(accountPaid),
        products: products,
        invoiceTotal,
        accountBalance,
        paid: accountBalance === 0
    };

    purchases.push(newPurchase);

    // Save the updated data
    saveData();

    res.redirect('/admin/vendor-invoices');
});


app.get('/admin/vendor-manage-payment', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchases = data.purchases || [];

    // Get all unpaid purchases
    const unpaidPurchases = purchases.filter(purchase => purchase.accountBalance > 0);

    // Sort by date descending
    unpaidPurchases.sort((a, b) => {
        const dateA = new Date(a.dateCreated);
        const dateB = new Date(b.dateCreated);
        return dateB - dateA;
    });

    res.render('vendor-manage-payment', { purchases: unpaidPurchases });
});

app.get('/admin/vendor-invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchases = data.purchases || [];
    const vendors = data.vendors || [];
    const vendorFilter = req.query.vendor;
    let filteredPurchases = purchases;
    if (vendorFilter) {
        filteredPurchases = purchases.filter(p => p.vendorName === vendorFilter);
    }
    res.render('vendor-portal', { purchases: filteredPurchases, vendors, inventory: data.inventory || [], vendorFilter });
});

app.get('/admin/view-vendors', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const vendors = data.vendors || [];
    res.render('view-vendors', { vendors });
});

app.get('/admin/add-vendor', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('add-vendor');
});

app.post('/admin/add-vendor', (req, res) => {
    console.log('Session logged in:', req.session.loggedIn, 'role:', req.session.user?.role);
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        console.log('Not logged in or not admin, redirecting');
        return res.redirect('/');
    }
    const { email, company, phone, addressLine1, addressLine2, city, state, zipCode } = req.body;
    console.log('Adding vendor:', company);
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    console.log('Loaded data vendors:', data.vendors);
    vendors = data.vendors || [];
    console.log('Global vendors before:', vendors.length);
    const newVendor = {
        id: vendors.length + 1,
        email,
        company,
        phone,
        addressLine1,
        addressLine2,
        city,
        state,
        zipCode
    };
    vendors.push(newVendor);
    console.log('Global vendors after push:', vendors.length);
    saveData();
    console.log('Data saved');
    res.redirect('/admin/view-vendors');
});

app.get('/admin/edit-vendor/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const vendorId = parseInt(req.params.id);
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) {
        return res.send('Vendor not found.');
    }
    res.render('edit-vendor', { vendor });
});

app.post('/admin/edit-vendor/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const vendorId = parseInt(req.params.id);
    const vendorIndex = vendors.findIndex(v => v.id === vendorId);

    if (vendorIndex === -1) {
        return res.status(404).send('Vendor not found.');
    }

    // Update vendor details
    vendors[vendorIndex].email = req.body.email;
    vendors[vendorIndex].company = req.body.company;
    vendors[vendorIndex].phone = req.body.phone;
    vendors[vendorIndex].addressLine1 = req.body.addressLine1;
    vendors[vendorIndex].addressLine2 = req.body.addressLine2;
    vendors[vendorIndex].city = req.body.city;
    vendors[vendorIndex].state = req.body.state;
    vendors[vendorIndex].zipCode = req.body.zipCode;

    saveData();
    res.redirect('/admin/view-vendors');
});

app.post('/admin/delete-vendor/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const vendorId = parseInt(req.params.id);
    
    // Find the index of the vendor to delete
    const vendorIndex = vendors.findIndex(v => v.id === vendorId);
    
    if (vendorIndex === -1) {
        return res.status(404).send('Vendor not found.');
    }
    
    // Remove the vendor from the vendors array
    vendors.splice(vendorIndex, 1);
    
    // Save the updated data
    saveData();
    
    // Redirect back to the vendors view
    res.redirect('/admin/view-vendors');
});

app.get('/admin/manage-payment', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.redirect('/admin/customer-manage-payment');
});

app.get('/admin/invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.redirect('/admin/customer-invoices');
});

app.get('/admin/purchases', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchases = data.purchases || [];
    const vendors = data.vendors || [];
    const inventory = data.inventory || [];
    const vendorFilter = req.query.vendor;
    let filteredPurchases = purchases;
    if (vendorFilter) {
        filteredPurchases = purchases.filter(p => p.vendorName === vendorFilter);
    }
    res.render('vendor-portal', { purchases: filteredPurchases, vendors, inventory, vendorFilter });
});


app.get('/admin/vendor-portal', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchases = data.purchases || [];

    res.render('vendor-portal', { purchases, vendorFilter: req.query.vendor });
});
app.get('/admin/purchases/:purchaseID', (req, res) => {
    const purchaseID = parseInt(req.params.purchaseID, 10);
    let data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchase = data.purchases.find(p => p.PurchaseID === purchaseID);

    if (!purchase) {
        return res.status(404).send('Purchase not found.');
    }

    res.render('purchase-details', { purchase, inventory });
});




app.post('/admin/purchases/:purchaseID', (req, res) => {
    const purchaseID = parseInt(req.params.purchaseID, 10);
    let data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchaseIndex = data.purchases.findIndex(p => p.PurchaseID === purchaseID);

    if (purchaseIndex === -1) {
        return res.status(404).send('Purchase not found.');
    }

    const { vendorName, dateCreated, invoiceNumber, cashPaid, accountPaid } = req.body;
    const products = JSON.parse(req.body.products);  // Ensure this line correctly parses the string

    // Calculate invoice total and account balance
    const invoiceTotal = products.reduce((sum, product) => sum + parseFloat(product.total), 0);
    const accountBalance = invoiceTotal - parseFloat(cashPaid) - parseFloat(accountPaid);

    // Update the existing purchase data
    const updatedPurchase = {
        ...data.purchases[purchaseIndex],
        vendorName,
        dateCreated: new Date(dateCreated).toLocaleDateString('en-US'),
        invoiceNumber,
        cashPaid: parseFloat(cashPaid),
        accountPaid: parseFloat(accountPaid),
        products: products,
        invoiceTotal,
        accountBalance,
        paid: accountBalance === 0
    };

    // Replace the old purchase with the updated purchase
    data.purchases[purchaseIndex] = updatedPurchase;

    // Write the updated data back to data.json
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf8');

    res.redirect(`/admin/purchases/${purchaseID}`);
});

// Handle DELETE request for a purchase
app.post('/admin/purchases/delete/:purchaseID', (req, res) => {
    const purchaseID = parseInt(req.params.purchaseID, 10);

    // Load data
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));

    // Filter out the purchase to be deleted
    data.purchases = data.purchases.filter(purchase => purchase.PurchaseID !== purchaseID);

    // Save to data.json
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf8');

    // Update global variable
    purchases = data.purchases;

    res.redirect('/admin/vendor-invoices');
});


function getAvailableQuarters(invoiceDates) {
    const minYear = moment.min(invoiceDates).year();
    const currentYear = moment().year();
    let quarters = [];

    // Create the four quarters for each year from the minimum year to the current year
    for (let year = minYear; year <= currentYear; year++) {
        quarters.push({
            label: `Jan 1 - Mar 31, ${year}`,
            start: `${year}-01-01`,
            end: `${year}-03-31`
        });
        quarters.push({
            label: `Apr 1 - Jun 30, ${year}`,
            start: `${year}-04-01`,
            end: `${year}-06-30`
        });
        quarters.push({
            label: `Jul 1 - Sep 30, ${year}`,
            start: `${year}-07-01`,
            end: `${year}-09-30`
        });
        quarters.push({
            label: `Oct 1 - Dec 31, ${year}`,
            start: `${year}-10-01`,
            end: `${year}-12-31`
        });
    }

    // Reverse to show the latest quarters first
    return quarters.reverse();
}
// Special route for PDF generation - bypasses login for PDF generation only
app.get('/products-pdf/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = users.find(u => u.id === userId);
    
    if (!user) {
        return res.status(404).send('User not found');
    }

    const userPriceLevel = `priceLevel${user.priceLevel}`;
    const finalPriceMultiplier = user.finalPrice || 1;

    // Adjust inventory prices based on user's price level
    const adjustedInventory = inventory.map(item => ({
        ...item,
        price: (Math.floor((item[userPriceLevel] * finalPriceMultiplier) * 4) / 4)
    }));

    // Sort inventory based on category rank
    adjustedInventory.sort((a, b) => {
        const rankA = categoryRanks[a.itemCategory] || Infinity;
        const rankB = categoryRanks[b.itemCategory] || Infinity;
        return rankA === rankB ? a.rank - b.rank : rankA - rankB;
    });

    // Create a fake session object for the template
    const fakeReq = {
        session: {
            user: user,
            loggedIn: true
        }
    };

    res.render('products-pdf', {
        inventory: adjustedInventory,
        req: fakeReq
    });
});

// Route to generate products PDF
// Direct PDF generation and download route - using PDFKit to create a grid layout with images
app.get('/generate-products-pdf-download', async (req, res) => {
    console.log('[PDF-GEN] Request received for PDF download');
    
    if (!req.session.loggedIn) {
        console.log('[PDF-GEN] Not logged in, redirecting');
        return res.redirect('/');
    }

    try {
        const user = req.session.user;
        const userPriceLevel = `priceLevel${user.priceLevel}`;
        const finalPriceMultiplier = user.finalPrice || 1;

        console.log('[PDF-GEN] Preparing inventory for:', user.company);

        // Only include items that are in-stock (quantity > 0)
        const visibleInventory = inventory.filter(it => {
            // treat undefined/null as zero
            const q = Number(it && it.quantity) || 0;
            return q > 0;
        });

        // Auto-map images: if item.imageUrl missing but a file named <id>.(jpg|png|jpeg|gif|webp) exists in public/uploads, set it in-memory.
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        const commonExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        let mappedCount = 0;
        visibleInventory.forEach(item => {
            if (!item) return;
            // normalize existing imageUrl
            if (item.imageUrl && typeof item.imageUrl === 'string' && item.imageUrl.length > 0) {
                // ensure it starts with /uploads/
                if (!item.imageUrl.startsWith('/uploads/') && item.imageUrl.startsWith('uploads/')) {
                    item.imageUrl = '/' + item.imageUrl;
                }
                return; // already has imageUrl
            }

            // try mapping by id
            if (item.id) {
                for (const ext of commonExts) {
                    const candidate = path.join(uploadsDir, String(item.id) + ext);
                    if (fs.existsSync(candidate)) {
                        item.imageUrl = '/uploads/' + String(item.id) + ext;
                        mappedCount++;
                        break;
                    }
                }
            }

            // fallback: try to match by itemName tokens (small heuristic)
            if (!item.imageUrl && item.itemName) {
                const nameTokens = item.itemName.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
                if (nameTokens.length) {
                    const files = fs.readdirSync(uploadsDir);
                    const match = files.find(f => nameTokens.some(t => f.toLowerCase().includes(t)));
                    if (match) {
                        item.imageUrl = '/uploads/' + match;
                        mappedCount++;
                    }
                }
            }
        });
        console.log('[PDF-GEN] Auto-mapped images count:', mappedCount);

        // Prepare inventory data (only visible items)
        const adjustedInventory = visibleInventory.map(item => ({
            ...item,
            price: (Math.floor((item[userPriceLevel] * finalPriceMultiplier) * 4) / 4)
        }));

        // Limit inventory to prevent excessive memory usage (max 200 items)
        const maxItems = 200;
        if (adjustedInventory.length > maxItems) {
            console.log(`[PDF-GEN] Limiting inventory to ${maxItems} items to prevent memory issues`);
            adjustedInventory.splice(maxItems);
        }

        const fileName = `products-${user.company.replace(/\s+/g, '-')}.pdf`;
        const filePath = path.join(__dirname, 'pdfs', fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        console.log('[PDF-GEN] Starting PDF generation with PDFKit...');
        
        // Check initial memory usage
        const memUsage = process.memoryUsage();
        console.log(`[PDF-GEN] Initial memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
        
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({
            size: 'A4',
            margin: 40,
            layout: 'portrait'
        });

        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // --- PDF Content Generation ---

        // Header (brand + month/year subtitle)
        const now = new Date();
        const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        doc.fontSize(18).font('Helvetica-Bold').text('Supply Stacker LLC', { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(12).font('Helvetica').text(`${monthYear} - Product Catalog`, { align: 'center' });
        doc.moveDown(1);

        // Grid layout settings (4 columns x 3 rows), evenly distribute vertical space between rows
        const itemsPerRow = 4;
        const rowsPerPage = 3;
        const itemsPerPage = itemsPerRow * rowsPerPage; // 12 items per page
        const pageMargin = 40;
        const gutter = 15;
        const availableWidth = doc.page.width - (pageMargin * 2);
        const cellWidth = (availableWidth - (gutter * (itemsPerRow - 1))) / itemsPerRow;

        // Reserve header area height so subsequent pages leave the same top gap
        const headerReservedTop = doc.y; // y position after drawing the main header

        // Compute available height for the grid (between header and bottom margin)
        const footerReserve = 30; // reserve for footer / page number area
        const availableHeight = doc.page.height - pageMargin - headerReservedTop - pageMargin - footerReserve;
        const cellHeight = (availableHeight - (gutter * (rowsPerPage - 1))) / rowsPerPage;

        let pageItemIndex = 0; // index of item within the current page
        let pageNumber = 1;

        const addPageHeader = () => {
            // Only print page number on subsequent pages (no company header)
            doc.fontSize(8).font('Helvetica').text(`Page ${pageNumber}`, doc.page.width - pageMargin - 50, pageMargin / 2, {
                align: 'right',
                width: 50
            });
            // Position the y cursor where the grid should start
            doc.y = headerReservedTop;
        };

        addPageHeader();

        for (const item of adjustedInventory) {
            // Start a new page when current page is full
            if (pageItemIndex >= itemsPerPage) {
                doc.addPage();
                pageNumber++;
                pageItemIndex = 0;
                addPageHeader();
            }

            const col = pageItemIndex % itemsPerRow;
            const row = Math.floor(pageItemIndex / itemsPerRow);
            const x = pageMargin + (col * (cellWidth + gutter));
            const y = headerReservedTop + (row * (cellHeight + gutter));


            // Draw image with memory-efficient resizing
            const imagePath = path.join(__dirname, 'public', item.imageUrl.startsWith('/') ? item.imageUrl.substring(1) : item.imageUrl);
            if (fs.existsSync(imagePath)) {
                try {
                    // Resize image to max 200x200 pixels to reduce memory usage
                    const resizedBuffer = await sharp(imagePath)
                        .resize(200, 200, {
                            fit: 'inside',
                            withoutEnlargement: true
                        })
                        .png({ quality: 80 })
                        .toBuffer();
                    
                    doc.image(resizedBuffer, x, y, {
                        fit: [cellWidth, cellHeight - 50],
                        align: 'center',
                        valign: 'center'
                    });
                } catch (imgErr) {
                    console.error(`[PDF-GEN] Image processing failed for ${imagePath}:`, imgErr.message);
                    // Draw an empty box if image processing fails
                    doc.rect(x, y, cellWidth, cellHeight - 50).stroke();
                    doc.fontSize(8).text('Image Error', x + 5, y + 5);
                }
            } else {
                console.error(`[PDF-GEN] Image file not found at path: ${imagePath}`);
                // Draw an empty box if the file doesn't exist
                doc.rect(x, y, cellWidth, cellHeight - 50).stroke();
                doc.fontSize(8).text('Not Found', x + 5, y + 5);
            }

            // Product Name + Price (allow multi-line names)
            try {
                // Reserve image area height
                const imageBoxHeight = cellHeight - 60; // leave space for name + price

                // Ensure font settings for measuring
                doc.font('Helvetica-Bold').fontSize(9);
                const nameHeight = doc.heightOfString(String(item.itemName || ''), { width: cellWidth });
                const nameY = y + imageBoxHeight + 6;

                // Draw the name (allow wrapping across multiple lines)
                doc.text(item.itemName || '', x, nameY, {
                    width: cellWidth,
                    align: 'center'
                });

                // Draw price below name
                const priceY = nameY + nameHeight + 6;
                doc.font('Helvetica').fontSize(10).text(`$${(item.price || 0).toFixed(2)}`, x, priceY, {
                    width: cellWidth,
                    align: 'center'
                });
            } catch (textErr) {
                console.error('[PDF-GEN] Error drawing text for', item.itemName, textErr.message);
            }

            pageItemIndex++;
        }

        doc.end();

        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        console.log('[PDF-GEN] PDF generated successfully with PDFKit at', filePath);
        
        // Check memory usage after PDF generation
        const memUsageAfter = process.memoryUsage();
        console.log(`[PDF-GEN] Memory usage after PDF generation: ${Math.round(memUsageAfter.heapUsed / 1024 / 1024)}MB`);
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log(`[PDF-GEN] Memory usage after GC: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        }

        // Check file size before compression
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log('[PDF-GEN] File size before compression:', fileSizeInMB, 'MB');
        }

        // Compress PDF using iLovePDF API
        console.log('[PDF-GEN] Starting PDF compression...');
        
        // Check memory usage before compression
        const memUsageBeforeCompress = process.memoryUsage();
        console.log(`[PDF-GEN] Memory usage before compression: ${Math.round(memUsageBeforeCompress.heapUsed / 1024 / 1024)}MB`);
        
        let compressedFilePath = filePath; // Default to original
        
        try {
            compressedFilePath = await compressPdfFile(filePath);
            console.log('[PDF-GEN] Compression successful');
        } catch (compressionErr) {
            console.error('[PDF-GEN] Compression failed:', compressionErr.message);
            console.log('[PDF-GEN] Will send uncompressed PDF');
            compressedFilePath = filePath;
        }
        
        // Check compressed file size
        if (fs.existsSync(compressedFilePath)) {
            const stats = fs.statSync(compressedFilePath);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log('[PDF-GEN] File size after compression:', fileSizeInMB, 'MB');
        }

        // Send compressed file to client
        console.log('[PDF-GEN] Sending compressed file to client');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        const fileStream = fs.createReadStream(compressedFilePath);
        
        fileStream.on('error', (err) => {
            console.error('[PDF-GEN] File stream error:', err.message);
            res.status(500).send('Error streaming PDF file: ' + err.message);
        });
        
        res.on('error', (err) => {
            console.error('[PDF-GEN] Response error:', err.message);
        });
        
        fileStream.pipe(res);
        
    } catch (err) {
        console.error('[PDF-GEN] ERROR:', err.message);
        console.error('[PDF-GEN] Stack:', err.stack);
        res.status(500).send('Error generating PDF: ' + err.message);
    }
});

app.post('/generate-products-pdf', async (req, res) => {
    console.log('[PDF-ROUTE] POST /generate-products-pdf - Request received');
    
    if (!req.session.loggedIn) {
        console.log('[PDF-ROUTE] Not logged in');
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    try {
        console.log('[PDF-ROUTE] Starting PDF generation process');
        const user = req.session.user;
        const userPriceLevel = `priceLevel${user.priceLevel}`;
        const finalPriceMultiplier = user.finalPrice || 1;

        console.log('[PDF-ROUTE] Preparing inventory for:', user.company);

        // Auto-map images: if item.imageUrl missing but a file named <id>.(jpg|png|jpeg|gif) exists in public/uploads, set it in-memory.
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        const commonExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        let mappedCount = 0;
        inventory.forEach(item => {
            if (!item) return;
            // normalize existing imageUrl
            if (item.imageUrl && typeof item.imageUrl === 'string' && item.imageUrl.length > 0) {
                // ensure it starts with /uploads/
                if (!item.imageUrl.startsWith('/uploads/') && item.imageUrl.startsWith('uploads/')) {
                    item.imageUrl = '/' + item.imageUrl;
                }
                return; // already has imageUrl
            }

            // try mapping by id
            if (item.id) {
                for (const ext of commonExts) {
                    const candidate = path.join(uploadsDir, String(item.id) + ext);
                    if (fs.existsSync(candidate)) {
                        item.imageUrl = '/uploads/' + String(item.id) + ext;
                        mappedCount++;
                        break;
                    }
                }
            }

            // fallback: try to match by itemName tokens (small heuristic)
            if (!item.imageUrl && item.itemName) {
                const nameTokens = item.itemName.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
                if (nameTokens.length) {
                    const files = fs.readdirSync(uploadsDir);
                    const match = files.find(f => nameTokens.some(t => f.toLowerCase().includes(t)));
                    if (match) {
                        item.imageUrl = '/uploads/' + match;
                        mappedCount++;
                    }
                }
            }
        });
        console.log('[PDF-ROUTE] Auto-mapped images count:', mappedCount);

        // Prepare inventory data
        const adjustedInventory = inventory.map(item => ({
            ...item,
            price: (Math.floor((item[userPriceLevel] * finalPriceMultiplier) * 4) / 4)
        }));

        const productsPdfData = {
            companyName: user.company,
            userId: user.id,
            dateGenerated: new Date().toISOString().split('T')[0],
            user: user,
            inventory: adjustedInventory
        };

        // Get base URL from request
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        const baseUrl = `${protocol}://${host}`;
        console.log('[PDF-ROUTE] Using baseUrl:', baseUrl);

        // Use await to wait for PDF generation
        console.log('[PDF-ROUTE] Calling pdfService.generateProductsPdfAsync');
        const filePath = await pdfService.generateProductsPdfAsync(productsPdfData, baseUrl);
        
        console.log('[PDF-ROUTE] PDF generated successfully:', filePath);
        res.json({ 
            success: true, 
            message: 'PDF generated successfully',
            downloadUrl: '/download-products-pdf'
        });
        
    } catch (err) {
        console.error('[PDF-ROUTE] ERROR:', err.message);
        console.error('[PDF-ROUTE] Stack:', err.stack);
        res.status(500).json({ 
            success: false, 
            message: 'PDF generation failed: ' + err.message 
        });
    }
});

// Route to download the generated products PDF
app.get('/download-products-pdf', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/');
    }

    const user = req.session.user;
    const filePath = `./pdfs/products-${user.company.replace(/\s+/g, '-')}.pdf`;
    
    // Check if file exists
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=' + `products-${user.company.replace(/\s+/g, '-')}.pdf`);
        
        // Stream the PDF file to the response
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
    } else {
        res.status(404).send('PDF not found.');
    }
});







// Admin Sales Tax Report Page - GET Route
app.get('/admin/salestaxreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    // Determine the available quarters
    let invoiceDates = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                invoiceDates.push(moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]));
            });
        }
    });

    if (invoiceDates.length === 0) {
        return res.render('salestaxreport', { quarters: [], invoices: [], selectedQuarter: null, totalSalesTax: 0 });
    }

    const quarters = getAvailableQuarters(invoiceDates);
    
    res.render('salestaxreport', { quarters: quarters, invoices: [], selectedQuarter: null, totalSalesTax: 0 });
});

// Admin Sales Tax Report Page - POST Route
app.post('/admin/salestaxreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const { quarter } = req.body;
    const [start, end] = quarter.split('|');

    let filteredInvoices = [];
    let totalSalesTax = 0;
    let totalGrossReceipts = 0;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]);
                const isCurrentMonth = invoiceDate.isBetween(start, end, undefined, '[]');
                const isLastMonth = invoiceDate.isBetween(startOfLastMonth, endOfLastMonth, undefined, '[]');

                // Calculate total gross receipts from all invoices, regardless of sales tax
                if (invoiceDate.isBetween(start, end, undefined, '[]')) {
                    console.log(invoice)
                    totalGrossReceipts += (invoice.totalAmount - invoice.CashPayment) || 0;

                    // Only add to filtered list if sales tax is greater than 0
                    if (invoice.salesTax > 0) {
                        filteredInvoices.push({
                            invoiceNumber: invoice.invoiceNumber,
                            date: invoiceDate.format("YYYY-MM-DD"),
                            salesTax: invoice.salesTax,
                            totalAmount: invoice.totalAmount
                        });
                        totalSalesTax += invoice.salesTax;
                    }
                }
            });
        }
    });

    // Calculating receipts not subject to sales tax using total gross receipts
    const receiptsNotSubjectToSalesTax = totalGrossReceipts - (totalSalesTax / 0.06625);

    // Rounding values to the nearest dollar
    const roundedGrossReceipts = Math.round(totalGrossReceipts);
    const roundedReceiptsNotSubjectToSalesTax = Math.round(receiptsNotSubjectToSalesTax);

    // Retrieve quarters again to ensure dropdown remains populated
    let invoiceDates = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                invoiceDates.push(moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]));
            });
        }
    });
    const quarters = getAvailableQuarters(invoiceDates);

    // Render the updated page with the selected quarter's invoices and calculated values
    res.render('salestaxreport', {
        quarters: quarters,
        invoices: filteredInvoices,
        selectedQuarter: quarter,
        totalGrossReceipts: roundedGrossReceipts,
        receiptsNotSubjectToSalesTax: roundedReceiptsNotSubjectToSalesTax,
        totalSalesTax: totalSalesTax.toFixed(2)
    });
});

// Admin Sales Report Page - GET Route
app.get('/admin/salesreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    
    // Calculate monthly sales for last 12 months
    let monthlySales = [];
    for (let i = 11; i >= 0; i--) {
        const monthDate = moment().subtract(i, 'months');
        monthlySales.push({
            label: monthDate.format('MMMM YYYY'),
            month: monthDate.month(),
            year: monthDate.year(),
            total: 0,
            isCurrentMonth: i === 0
        });
    }
    
    // Calculate sales for each month
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]);
                const invoiceMonth = invoiceDate.month();
                const invoiceYear = invoiceDate.year();
                
                const monthData = monthlySales.find(m => m.month === invoiceMonth && m.year === invoiceYear);
                if (monthData && invoice.totalAmount) {
                    monthData.total += invoice.totalAmount;
                }
            });
        }
    });
    
    // Calculate average (excluding current month - divide by 11)
    const pastMonthsSales = monthlySales.filter(m => !m.isCurrentMonth);
    const totalPastSales = pastMonthsSales.reduce((sum, m) => sum + m.total, 0);
    const monthlyAverage = pastMonthsSales.length > 0 ? totalPastSales / pastMonthsSales.length : 0;
    
    res.render('salesreport', {
        monthlySales: monthlySales,
        monthlyAverage: monthlyAverage,
        customRangeTotal: null,
        startDate: null,
        endDate: null
    });
});

// Admin Sales Report Page - POST Route
app.post('/admin/salesreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const { startDate, endDate } = req.body;
    
    const start = moment(startDate, 'YYYY-MM-DD').startOf('day');
    const end = moment(endDate, 'YYYY-MM-DD').endOf('day');

    let totalSales = 0;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]);
                if (invoiceDate.isBetween(start, end, undefined, '[]')) {
                    totalSales += invoice.totalAmount || 0;
                }
            });
        }
    });

    // Recalculate monthly sales for the dashboard
    let monthlySales = [];
    for (let i = 11; i >= 0; i--) {
        const monthDate = moment().subtract(i, 'months');
        monthlySales.push({
            label: monthDate.format('MMMM YYYY'),
            month: monthDate.month(),
            year: monthDate.year(),
            total: 0,
            isCurrentMonth: i === 0
        });
    }
    
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, ["MM/DD/YYYY", "YYYY-MM-DD"]);
                const invoiceMonth = invoiceDate.month();
                const invoiceYear = invoiceDate.year();
                
                const monthData = monthlySales.find(m => m.month === invoiceMonth && m.year === invoiceYear);
                if (monthData && invoice.totalAmount) {
                    monthData.total += invoice.totalAmount;
                }
            });
        }
    });
    
    const pastMonthsSales = monthlySales.filter(m => !m.isCurrentMonth);
    const totalPastSales = pastMonthsSales.reduce((sum, m) => sum + m.total, 0);
    const monthlyAverage = pastMonthsSales.length > 0 ? totalPastSales / pastMonthsSales.length : 0;
    
    res.render('salesreport', {
        monthlySales: monthlySales,
        monthlyAverage: monthlyAverage,
        customRangeTotal: totalSales,
        startDate: startDate,
        endDate: endDate
    });
});

// Helper function to find a matching inventory item by similar name
function findMatchingInventoryItem(productName) {
    // First try exact match
    let match = inventory.find(i => i.itemName === productName);
    if (match) return match;
    
    // Normalize the product name for comparison (remove special chars, extra spaces, convert to lowercase)
    const normalize = (str) => {
        return str.toLowerCase()
            .replace(/[()]/g, ' ')  // Replace parentheses with spaces
            .replace(/\s+/g, ' ')   // Collapse multiple spaces
            .trim();
    };
    
    const normalizedProductName = normalize(productName);
    
    // Try to find a similar product in inventory
    // Score each inventory item by how well it matches
    let bestMatch = null;
    let bestScore = 0;
    
    inventory.forEach(item => {
        const normalizedItemName = normalize(item.itemName);
        
        // Check if one contains the other (partial match)
        if (normalizedItemName.includes(normalizedProductName) || 
            normalizedProductName.includes(normalizedItemName)) {
            const score = Math.min(normalizedItemName.length, normalizedProductName.length) / 
                          Math.max(normalizedItemName.length, normalizedProductName.length);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = item;
            }
        }
        
        // Check word overlap (useful for products like "Paper Bags 8x4x10 Twisted Handle")
        const productWords = normalizedProductName.split(' ').filter(w => w.length > 2);
        const itemWords = normalizedItemName.split(' ').filter(w => w.length > 2);
        
        let matchingWords = 0;
        productWords.forEach(pw => {
            if (itemWords.some(iw => iw.includes(pw) || pw.includes(iw))) {
                matchingWords++;
            }
        });
        
        // If more than 60% of words match, consider it a potential match
        const wordScore = matchingWords / Math.max(productWords.length, itemWords.length);
        if (wordScore > 0.6 && wordScore > bestScore) {
            bestScore = wordScore;
            bestMatch = item;
        }
    });
    
    // Only return a match if the score is good enough (above 50%)
    return bestScore >= 0.5 ? bestMatch : null;
}

// Route for Admin Sales By Product Report
// Helper function to calculate sales by product data for a time period
function calculateSalesByProductPeriod(months) {
    const endDate = moment();
    const startDate = moment().subtract(months, 'months').startOf('month');
    const prevStartDate = moment().subtract(months * 2, 'months').startOf('month');
    const prevEndDate = moment().subtract(months, 'months').subtract(1, 'day');

    let reportData = {};
    let totalSales = 0;
    let totalQuantity = 0;

    // Iterate through all users and their invoices to gather sales data
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, ['YYYY-MM-DD', 'MM/DD/YYYY']);
                const isCurrentPeriod = invoiceDate.isBetween(startDate, endDate, undefined, '[]');
                const isPrevPeriod = invoiceDate.isBetween(prevStartDate, prevEndDate, undefined, '[]');

                invoice.products.forEach(product => {
                    // Find matching inventory item using fuzzy matching
                    const inventoryItem = findMatchingInventoryItem(product.productName);
                    
                    // Use the inventory item's name as the key if found, otherwise use product name
                    const keyName = inventoryItem ? inventoryItem.itemName : product.productName;
                    
                    if (!reportData[keyName]) {
                        reportData[keyName] = {
                            productName: keyName,
                            imageUrl: inventoryItem ? inventoryItem.imageUrl : null,
                            inventoryQuantity: inventoryItem ? (inventoryItem.quantity || 0) : 0,
                            quantitySold: 0,
                            quantitySoldPrev: 0,
                            totalAmount: 0,
                            totalAmountPrev: 0,
                            rate: product.rate
                        };
                    }

                    if (isCurrentPeriod) {
                        reportData[keyName].quantitySold += product.quantity;
                        reportData[keyName].totalAmount += product.total;
                        totalSales += product.total;
                        totalQuantity += product.quantity;
                    }

                    if (isPrevPeriod) {
                        reportData[keyName].quantitySoldPrev += product.quantity;
                        reportData[keyName].totalAmountPrev += product.total;
                    }
                });
            });
        }
    });

    // Convert reportData object to an array and sort by totalAmount
    const reportDataArray = Object.values(reportData).sort((a, b) => b.totalAmount - a.totalAmount);
    
    return {
        reportData: reportDataArray,
        totalSales,
        totalQuantity,
        uniqueProducts: reportDataArray.filter(p => p.quantitySold > 0).length
    };
}

app.get('/admin/salesbyproductreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    
    // Default to last 3 months
    const data = calculateSalesByProductPeriod(3);
    
    res.render('salesbyproductreport', { 
        reportData: data.reportData, 
        period: '3',
        totalSales: data.totalSales,
        totalQuantity: data.totalQuantity,
        uniqueProducts: data.uniqueProducts,
        inventory: inventory,
        users: users
    });
});

app.post('/admin/salesbyproductreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const period = req.body.period || '3'; // Default 3 months
    const data = calculateSalesByProductPeriod(parseInt(period));

    res.render('salesbyproductreport', { 
        reportData: data.reportData, 
        period: period,
        totalSales: data.totalSales,
        totalQuantity: data.totalQuantity,
        uniqueProducts: data.uniqueProducts,
        inventory: inventory,
        users: users
    });
});

app.get('/admin/returns', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }
    res.render('returns-form');
});

app.post('/admin/returns', multerUpload.array('images', 10), (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    try {
        // Create a new return object
        const newReturn = {
            returnNumber: returns.length > 0
                ? String(returns.length + 1).padStart(3, '0')
                : "001",
            date: req.body.date || moment().format('YYYY-MM-DD'),
            classification: req.body.classification,
            damaged: req.body.damaged === 'true',
            trackingNumber: req.body.trackingNumber || "",
            processed: false,
            images: req.files.map(file => file.filename) // Save file names
        };

        // Add the new return to the returns array
        returns.push(newReturn);

        // Save to data.json
        saveData();

        res.redirect('/admin/returns'); // Redirect back to the form for repeated submissions
    } catch (error) {
        console.error(error);
        res.status(500).send('An error occurred while processing the return.');
    }
});

app.get('/admin/manageReturns', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    res.render('manage-returns', { returns: data.returns || [] });
});

app.get('/admin/manageReturns/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.redirect('/');
    }

    // Find the specific return
    const returnData = returns.find(r => r.returnNumber === req.params.id);

    if (!returnData) {
        return res.status(404).send('Return not found.');
    }

    res.render('return-details', { returnData });
});




app.get('/admin/manageReturns/:id/download', (req, res) => {
    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const ret = data.returns.find(r => r.returnNumber === req.params.id);

    if (!ret || !ret.images || ret.images.length === 0) {
        return res.status(404).send('No images found for this return.');
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`${ret.returnNumber}.zip`);

    archive.pipe(res);
    ret.images.forEach(img => {
        archive.file(`./public/uploads/${img}`, { name: img });
    });

    archive.finalize();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
