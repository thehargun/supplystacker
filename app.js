const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const pdfService = require('./services/pdfService');
const emailService = require('./services/emailService');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const app = express();

let users = []; // To include both admin and customer users
let inventory = [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, rank: 0, imageUrl: "/path/to/image1.jpg" },
];
let invoices = [];

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: 'secret123',
    resave: true,
    saveUninitialized: true
}));

app.use((req, res, next) => {
    res.locals.req = req; // Make req available in EJS views
    next();
});

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Init upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 1000000 }, // 1 MB
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('image');

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
        users = json.users;
        inventory = json.inventory;
    } catch (error) {
        console.log('No existing data found, starting with empty arrays.');
    }
}

loadData();
setInterval(saveData, 10000);

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
    const data = {
        users: users,
        inventory: inventory,
    };
    fs.writeFileSync('data.json', JSON.stringify(data), 'utf8');
}


const cron = require('node-cron'); // Add this at the top of the file along with other requires

// Function to send the latest data.json file via email
function sendLatestDataJson() {
    const filePath = path.join(__dirname, 'data.json');
    emailService.sendEmailWithAttachment('sales@supplystacker.com', 'Latest data.json file', 'Please find the latest data.json file attached.', filePath)
        .then(() => {
            console.log('Latest data.json file sent successfully.');
        })
        .catch(error => {
            console.error('Error sending latest data.json file:', error);
        });
}

// Schedule the task to run every hour
cron.schedule('0 * * * *', () => {
    sendLatestDataJson();
});


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
        return res.status(403).send('Access denied.');
    }
    res.render('admin');
});

app.get('/admin/view-inventory', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    res.render('view-inventory', { inventory });
});

app.get('/admin/add-inventory', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    res.render('add-inventory', { inventory });
});

app.post('/admin/add-inventory', upload, (req, res) => {
    if (req.file == undefined) {
        return res.send('Error: No file selected!');
    }

    let { itemName, itemCategory, otherCategory, quantity, cost, priceLevel1, priceLevel2, priceLevel3, rank } = req.body;
    const imageUrl = '/uploads/' + req.file.filename;

    if (itemCategory === 'Other' && otherCategory) {
        itemCategory = otherCategory;
    }

    inventory.push({
        id: inventory.length + 1,
        itemName,
        itemCategory,
        cost: parseFloat(cost),
        quantity: parseInt(quantity),
        priceLevel1: parseFloat(priceLevel1),
        priceLevel2: parseFloat(priceLevel2),
        priceLevel3: parseFloat(priceLevel3),
        rank: 0,
        imageUrl
    });

    res.redirect('/admin/view-inventory');
});

app.get('/admin/edit-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    const item = inventory.find(item => item.id === parseInt(req.params.id));
    res.render('edit-inventory', { item });
});

app.post('/admin/edit-inventory/:id', upload, async (req, res) => {
    const itemId = parseInt(req.params.id);
    const itemIndex = inventory.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
        return res.status(404).send('Item not found.');
    }

    const currentItem = inventory[itemIndex];

    currentItem.itemName = req.body.itemName || currentItem.itemName;
    currentItem.itemCategory = req.body.itemCategory || currentItem.itemCategory;
    currentItem.cost = req.body.cost ? parseFloat(req.body.cost) : currentItem.cost;
    currentItem.quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : currentItem.quantity;
    currentItem.priceLevel1 = req.body.priceLevel1 ? parseFloat(req.body.priceLevel1) : currentItem.priceLevel1;
    currentItem.priceLevel2 = req.body.priceLevel2 ? parseFloat(req.body.priceLevel2) : currentItem.priceLevel2;
    currentItem.priceLevel3 = req.body.priceLevel3 ? parseFloat(req.body.priceLevel3) : currentItem.priceLevel3;
    currentItem.rank = req.body.rank ? parseFloat(req.body.rank) : currentItem.rank;

    if (req.file) {
        const newImageUrl = '/uploads/' + req.file.filename;
        currentItem.imageUrl = newImageUrl;
    }

    inventory[itemIndex] = currentItem;
    res.redirect('/admin/view-inventory');
});

app.get('/admin/delete-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    inventory = inventory.filter(item => item.id !== parseInt(req.params.id));
    res.redirect('/admin/view-inventory');
});

app.get('/admin/view-customers', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('view-customers', { customers: users });
});

app.get('/admin/add-customer', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('add-customer');
});

app.post('/admin/add-customer', async (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const { email, password, company, phone, addressLine1, addressLine2, city, state, zipCode, priceLevel } = req.body;
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
        priceLevel,
        role: 'customer',
        invoices: []
    };

    users.push(newCustomer);
    res.redirect('/admin/view-customers');
});

app.get('/products', (req, res) => {
    if (!req.session.loggedIn) return res.send('Please log in.');

    const userPriceLevel = req.session.user.priceLevel || '3';

    const sortedInventory = inventory.sort((a, b) => b.rank - a.rank);

    const adjustedInventory = sortedInventory.map(item => ({
        ...item,
        price: item[`priceLevel${userPriceLevel}`]
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
            req.session.cart[existingItemIndex].quantity += parseInt(quantity, 10);
        } else {
            req.session.cart.push({
                ...item,
                quantity: parseInt(quantity, 10),
                price
            });
        }
    }
    res.redirect('/cart');
});

app.get('/cart', (req, res) => {
    if (!req.session.loggedIn) return res.send('Please log in.');
    res.render('cart', { cart: req.session.cart || [] });
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

    const updatedCustomer = {
        id: customerId,
        email: req.body.email,
        password: req.body.password ? await bcrypt.hash(req.body.password, 10) : undefined,
        company: req.body.company,
        phone: req.body.phone,
        addressLine1: req.body.addressLine1,
        addressLine2: req.body.addressLine2,
        city: req.body.city,
        state: req.body.state,
        zipCode: req.body.zipCode,
        priceLevel: parseInt(req.body.priceLevel),
    };

    const index = users.findIndex(customer => customer.id === customerId);
    if (index === -1) {
        return res.send('Customer not found.');
    }

    users[index] = { ...users[index], ...updatedCustomer };

    res.redirect('/admin/view-customers');
});

app.get('/admin/invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    let allInvoices = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            allInvoices = allInvoices.concat(user.invoices);
        }
    });

    res.render('invoices', { invoices: allInvoices });
});
// ... existing code ...
// Route to render invoice details page
app.get('/admin/invoices/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceDetails = null;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            const invoice = user.invoices.find(inv => inv.invoiceNumber === invoiceNumber);
            if (invoice) {
                invoiceDetails = invoice;
            }
        }
    });

    if (!invoiceDetails) {
        return res.status(404).send('Invoice not found.');
    }

    res.render('invoice-details', { invoice: invoiceDetails, inventory: inventory });
});



app.post('/admin/invoices/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let userIndex = null;
    let invoiceIndex = null;
    let updatedInvoice = null;

    users.forEach((user, uIndex) => {
        if (user.invoices && user.invoices.length > 0) {
            const foundInvoiceIndex = user.invoices.findIndex(inv => inv.invoiceNumber === invoiceNumber);
            if (foundInvoiceIndex !== -1) {
                updatedInvoice = user.invoices[foundInvoiceIndex];
                userIndex = uIndex;
                invoiceIndex = foundInvoiceIndex;
            }
        }
    });

    if (!updatedInvoice) {
        return res.status(404).send('Invoice not found.');
    }

    // Update invoice number
    if (req.body.invoiceNumber) {
        updatedInvoice.invoiceNumber = req.body.invoiceNumber;
    }

    // Update invoice fields only if they have changed
    const fieldsToUpdate = ['companyName', 'addressLine1', 'addressLine2', 'city', 'state', 'zipCode', 'dateCreated', 'CashPayment', 'AccountPayment'];
    fieldsToUpdate.forEach(field => {
        if (req.body[field] !== undefined && req.body[field] !== null) {
            if (field === 'CashPayment' || field === 'AccountPayment') {
                updatedInvoice[field] = parseFloat(req.body[field]) || 0; // Ensure CashPayment and AccountPayment are numbers
            } else if (field === 'dateCreated') {
                let date = new Date(req.body[field]);
                date.setDate(date.getDate() + 1); // Increment the date by 1 day
                updatedInvoice[field] = date.toLocaleDateString('en-US');
            } else {
                updatedInvoice[field] = req.body[field];
            }
        }
    });

    // Log the raw product data
    console.log("Raw product data:", req.body.products);

    // Parse and update products
    let products;
    try {
        products = JSON.parse(req.body.products);
        console.log("Parsed products:", products);  // Log parsed products
    } catch (error) {
        console.error("Error parsing product data:", error);  // Log the error
        return res.status(400).send('Invalid product data.');
    }

    // Ensure all required fields in products are present
    const validProducts = products.every(product => 
        product.productName && product.productCategory && !isNaN(product.quantity) && !isNaN(product.rate) && !isNaN(product.total)
    );

    if (!validProducts) {
        console.error("Invalid product data structure:", products);  // Log invalid products
        return res.status(400).send('Invalid product data.');
    }

    updatedInvoice.products = products;

    // Calculate invoiceTotal
    updatedInvoice.invoiceTotal = products.reduce((sum, product) => sum + product.total, 0);

    // Calculate and update totalBalance and paid status
    updatedInvoice.totalBalance = updatedInvoice.invoiceTotal - updatedInvoice.CashPayment - updatedInvoice.AccountPayment;
    updatedInvoice.paid = updatedInvoice.totalBalance <= 0;

    // Update the user's invoice
    users[userIndex].invoices[invoiceIndex] = updatedInvoice;

    // Save updated data to data.json
    saveData();

    res.redirect(`/admin/invoices/${invoiceNumber}`);
});

app.post('/admin/invoices/print/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceDetails = null;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            const invoice = user.invoices.find(inv => inv.invoiceNumber === invoiceNumber);
            if (invoice) {
                invoiceDetails = invoice;
            }
        }
    });

    if (!invoiceDetails) {
        return res.status(404).send('Invoice not found.');
    }

    pdfService.generateInvoicePdf(invoiceDetails, pdfFilePath => {
        emailService.sendOrderConfirmationWithInvoice('sales@supplystacker.com', invoiceDetails, pdfFilePath);
        res.send('Invoice has been sent successfully.');
    });
});































app.get('/admin/invoices/delete/:invoiceNumber', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const invoiceNumber = req.params.invoiceNumber;
    let invoiceFound = false;

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            const invoiceIndex = user.invoices.findIndex(inv => inv.invoiceNumber === invoiceNumber);
            if (invoiceIndex !== -1) {
                user.invoices.splice(invoiceIndex, 1);
                invoiceFound = true;
            }
        }
    });

    if (!invoiceFound) {
        return res.status(404).send('Invoice not found.');
    }

    // Save updated data to data.json
    saveData();

    res.redirect('/admin/invoices');
});


app.delete('/remove-from-cart/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    if (!req.session.cart || !req.session.cart.length) {
        return res.status(400).send('Cart is empty.');
    }

    req.session.cart = req.session.cart.filter(item => item.id !== itemId);
    res.sendStatus(204);
});

app.put('/update-cart/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const newQuantity = parseInt(req.body.quantity);

    if (!req.session.cart || !req.session.cart.length) {
        return res.status(400).send('Cart is empty.');
    }

    const itemIndex = req.session.cart.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
        return res.status(404).send('Item not found in cart.');
    }

    req.session.cart[itemIndex].quantity = newQuantity;
    res.sendStatus(204);
});

app.get('/get-total-amount', (req, res) => {
    const totalAmount = req.session.cart.reduce((total, item) => total + (item.price * item.quantity), 0);
    res.json({ totalAmount });
});

function generateInvoiceNumber(company, lastInvoiceNumber) {
    lastInvoiceNumber = typeof lastInvoiceNumber === 'number' ? lastInvoiceNumber : 0;
    lastInvoiceNumber += 1;
    const initials = company.split(' ').map(word => word[0]).join('').toUpperCase();
    return `${initials}${String(lastInvoiceNumber).padStart(2, '0')}`;
}

app.get('/checkout', (req, res) => {
    if (!req.session.user || !req.session.cart) {
        return res.status(400).send('User is not logged in or cart is empty.');
    }
    const cart = req.session.cart;
    const user = req.session.user;
    user.invoices = user.invoices || [];
    const invoiceNumber = generateInvoiceNumber(user.company, user.lastInvoiceNumber);
    res.render('checkout', { invoiceNumber, cart });
});

app.post('/submit-order', async (req, res) => {
    if (!req.session.cart || !req.session.user) {
        return res.send('No items in cart or user not logged in.');
    }

    const user = req.session.user;
    user.invoices = user.invoices || [];
    user.lastInvoiceNumber = user.lastInvoiceNumber ? user.lastInvoiceNumber + 1 : 1;

    const invoiceNumber = generateInvoiceNumber(user.company, (user.lastInvoiceNumber - 1));

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

    user.invoices.push(invoiceDetails);

    const userIndex = users.findIndex(u => u.id === user.id);
    if (userIndex !== -1) {
        users[userIndex] = user;
    } else {
        return res.status(404).send('User not found.');
    }

    req.session.user = user;

    pdfService.generateInvoicePdf(invoiceDetails, pdfFilePath => {
        emailService.sendOrderConfirmationWithInvoice('sales@supplystacker.com', invoiceDetails, pdfFilePath);

        req.session.cart = [];

        res.render('order-submitted', { message: 'Order submitted successfully. Thank you!' });
    });

});

app.get('/admin/manage-payment', (req, res) => {
    res.render('manage-payment');
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

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
