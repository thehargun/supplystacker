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

let categoryRanks = {};
let users = []; // To include both admin and customer users
let inventory = [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, rank: 0, imageUrl: "/path/to/image1.jpg" },
];
let purchases = []

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

        if (json && Array.isArray(json.users) && Array.isArray(json.inventory) && Array.isArray(json.purchases)) {
            users = json.users;
            inventory = json.inventory;
            purchases = json.purchases;

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
    const data = {
        users: users,
        inventory: inventory,
        purchases: purchases,
        ItemsCategory: Object.keys(categoryRanks).map(category => ({
            Category: category,
            Rank: categoryRanks[category]
        }))
    };
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf8');
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
        return res.status(403).send('Access denied.');
    }
    res.render('admin');
});

app.get('/admin/view-inventory', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
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
    currentItem.vendors = req.body.vendors || currentItem.vendors;
    currentItem.length = req.body.length ? parseFloat(req.body.length) : currentItem.length;
    currentItem.width = req.body.width ? parseFloat(req.body.width) : currentItem.width;
    currentItem.height = req.body.height ? parseFloat(req.body.height) : currentItem.height;
    currentItem.weight = req.body.weight ? parseFloat(req.body.weight) : currentItem.weight;
    currentItem.palletqty = req.body.palletqty ? parseInt(req.body.palletqty, 10) : currentItem.palletqty;

    if (req.file) {
        const newImageUrl = '/uploads/' + req.file.filename;
        currentItem.imageUrl = newImageUrl;
    }

    inventory[itemIndex] = currentItem;
    saveData();

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

    // Sort inventory based on category rank and item rank
    inventory.sort((a, b) => {
        const rankA = categoryRanks[a.itemCategory] || Infinity;
        const rankB = categoryRanks[b.itemCategory] || Infinity;
        return rankA === rankB ? a.rank - b.rank : rankA - rankB;
    });

    const adjustedInventory = inventory.map(item => ({
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

const parseInvoiceNumber = (invoiceNumber) => {
    const match = invoiceNumber.match(/([A-Za-z]+)(\d+)/);
    return match ? { prefix: match[1], number: parseInt(match[2], 10) } : { prefix: invoiceNumber, number: 0 };
};

const sortInvoicesByNumber = (invoices) => {
    return invoices.sort((a, b) => {
        const parsedA = parseInvoiceNumber(a.invoiceNumber);
        const parsedB = parseInvoiceNumber(b.invoiceNumber);
        if (parsedA.prefix === parsedB.prefix) {
            return parsedA.number - parsedB.number;
        }
        return parsedA.prefix.localeCompare(parsedB.prefix);
    });
};

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

    // Sort the invoices by invoice number before rendering
    const sortedInvoices = sortInvoicesByNumber(allInvoices);

    res.render('invoices', { invoices: sortedInvoices });
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
                date.setDate(date.getDate()-1); // Increment the date by 1 day
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
app.post('/admin/duplicate-inventory/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const item = inventory.find(item => item.id === itemId);

    if (!item) {
        return res.status(404).send('Item not found.');
    }

    const newItem = { ...item, id: inventory.length + 1 };
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

app.post('/admin/delete-vendor/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    const itemIndex = inventory.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
        return res.status(404).send({ success: false, message: 'Item not found.' });
    }

    const { index } = req.body;

    if (index >= 0 && index < inventory[itemIndex].vendors.length) {
        inventory[itemIndex].vendors.splice(index, 1);
    } else {
        return res.status(400).send({ success: false, message: 'Invalid vendor index.' });
    }

    saveData();  // Save the updated data to data.json

    res.json({ success: true });
});
app.get('/admin/purchases', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('purchases', { inventory });
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
    const { vendorName, dateCreated, invoiceNumber, cashPaid, accountPaid, paid } = req.body;
    const products = JSON.parse(req.body.products || '[]');

    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).send('No products provided.');
    }

    console.log('Received Products:', products);  // Debugging line
    console.log('Current Inventory:', inventory);  // Debugging line

    products.forEach(product => {
        const itemIndex = inventory.findIndex(item => item.itemName === product.productName);
        console.log('Product Name:', product.productName, 'Index Found:', itemIndex); // Debugging line
    
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

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    
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
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

    res.redirect('/admin/purchases');
});

app.get('/admin/vendor-portal', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    const purchases = data.purchases || [];

    res.render('vendor-portal', { purchases });
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

    // Filter out the purchase to be deleted
    purchases = purchases.filter(purchase => purchase.PurchaseID !== purchaseID);

    res.redirect('/admin/vendor-portal');
});





const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
