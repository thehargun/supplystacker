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
const moment = require('moment');
const archiver = require('archiver');

let categoryRanks = {};
let users = []; // To include both admin and customer users
let inventory = [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, rank: 0, imageUrl: "/path/to/image1.jpg" },
];
let returns = [];
let vendorsList = [];
let purchases = []

app.set('view engine', 'ejs');
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

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Initialize multer
const multerUpload = multer({
    storage: storage,
    limits: { fileSize: 1000000 }, // 1 MB
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png|gif/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Error: Images only!'));
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
            vendorsList = json.vendors;
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
    const data = {
        users: users,
        inventory: inventory,
        purchases: purchases,
        returns: returns, // Save the returns array
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
        return res.send('Unauthorized access.');
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
        return res.send('Please log in.');
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
    if (!req.session.loggedIn) return res.send('Please log in.');

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
        console.log("Unauthorized access attempt");
        return res.status(403).send('Access denied.');
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


app.post('/admin/invoices/print/:invoiceNumber', (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    const orderDetails = req.body;
    console.log(orderDetails)

    pdfService.generateInvoicePdf(orderDetails, (filePath) => {
        emailService.sendOrderConfirmationWithInvoice(orderDetails.companyName, orderDetails, filePath);
        res.status(200).send('Invoice PDF generated and sent successfully.');
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

app.get('/admin/manage-payment/invoices/delete/:invoiceNumber', (req, res) => {
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

app.post('/update-cart', (req, res) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }

    const { itemId, quantity } = req.body;

    // Find the item in the cart and update its quantity
    const itemIndex = req.session.cart.findIndex(item => item.id == itemId);
    if (itemIndex !== -1) {
        req.session.cart[itemIndex].quantity = parseFloat(quantity);

        // Recalculate the subtotal, sales tax, and total amount
        let subtotal = 0;
        let salesTax = 0;

        req.session.cart.forEach(item => {
            let itemTotal = item.price * item.quantity;
            subtotal += itemTotal;

            if (item.taxableItem) {
                salesTax += itemTotal * 0.06625; // 6.625% tax
            }
        });

        let totalAmount = subtotal + salesTax;

        // Send the updated totals back to the client
        res.json({
            success: true,
            subtotal,
            salesTax,
            totalAmount
        });
    } else {
        res.status(404).send({ success: false, message: 'Item not found in cart.' });
    }
});


app.get('/get-total-amount', (req, res) => {
    const totalAmount = req.session.cart.reduce((total, item) => total + (item.price * item.quantity), 0);
    res.json({ totalAmount });
});

function generateInvoiceNumber(company) {
    // Locate the user by company name
    const user = users.find(user => user.company === company);
    if (!user) {
        throw new Error('User company information is missing.');
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
}






app.get('/checkout', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/login'); // Redirect to login if not logged in
    }

    let cart = req.session.cart || [];
    let user = req.session.user;

    // Calculate subtotal, sales tax, and total
    let subtotal = 0;
    let salesTax = 0;

    cart.forEach(item => {
        let itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

        // If the user is taxable and the item is taxable, calculate the sales tax
        if (user.taxable && item.taxableItem) {
            salesTax += itemTotal * 0.06625; // 6.625% tax
        }
    });

    let totalAmount = subtotal + salesTax;

    // Render the checkout page with these values
    res.render('checkout', {
        cart: cart,
        subtotal: subtotal.toFixed(2),
        salesTax: salesTax.toFixed(2),
        totalAmount: totalAmount.toFixed(2)
    });
});

app.post('/checkout', async (req, res) => {
    if (!req.session.cart || !req.session.user) {
        return res.send('No items in cart or user not logged in.');
    }

    let user = req.session.user;

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
            quantity: item.quantity,  // Numeric value
            rate: item.price,         // Numeric value
            total: item.quantity * item.price  // Numeric value
        })),
        subtotal: subtotal,            // Numeric value
        salesTax: salesTax,            // Numeric value
        totalAmount: totalAmount,      // Numeric value
        totalBalance: totalAmount,     // Numeric value
        paid: false,
        CashPayment: 0,                // Default as a numeric value
        AccountPayment: 0              // Default as a numeric value
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
        console.error("User not found in users array.");
        return res.status(404).send('User not found.');
    }

    // Update session user data to reflect the new invoice
    req.session.user = user;

    // Save data to data.json (implement saveData function accordingly)
    saveData();

    // Clear the cart after checkout
    req.session.cart = [];

    // Render the order submission page with invoice details
    res.render('order-submitted', { invoice: invoiceDetails });
});




app.post('/submit-order', async (req, res) => {
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

app.get('/admin/manage-payment', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    // Get all unpaid invoices
    let unpaidInvoices = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            unpaidInvoices = unpaidInvoices.concat(user.invoices.filter(invoice => invoice.paid === false));
        }
    });

    // Sort the invoices by date in descending order
    unpaidInvoices.sort((a, b) => {
        const dateA = new Date(a.dateCreated);
        const dateB = new Date(b.dateCreated);
        return dateB - dateA; // descending order
    });

    res.render('manage-payment', { invoices: unpaidInvoices });
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
    let { vendorName, newVendor, dateCreated, invoiceNumber, cashPaid, accountPaid, paid } = req.body;
    const products = JSON.parse(req.body.products || '[]');

    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).send('No products provided.');
    }

    // Check if a new vendor is being added
    if (vendorName === 'other' && newVendor) {
        vendorName = newVendor;
        // Add the new vendor to the vendor list if not already there
        const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
        if (!data.vendors) {
            data.vendors = [];
        }

        if (!data.vendors.includes(newVendor)) {
            data.vendors.push(newVendor);
            // Save the updated vendors list
            fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
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

    // Save the updated purchases array in data.json
    data.purchases = purchases;
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
app.post('/delete-cart-item', (req, res) => {
    if (!req.session.cart) {
        req.session.cart = [];
    }

    const { itemId } = req.body;

    // Remove the item from the cart
    req.session.cart = req.session.cart.filter(item => item.id != itemId);

    // Recalculate the subtotal, sales tax, and total amount
    let subtotal = 0;
    let salesTax = 0;

    req.session.cart.forEach(item => {
        let itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

        if (item.taxableItem) {
            salesTax += itemTotal * 0.06625; // 6.625% tax
        }
    });

    let totalAmount = subtotal + salesTax;

    // Send the updated totals back to the client
    res.json({
        success: true,
        subtotal,
        salesTax,
        totalAmount
    });
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

// Admin Sales Tax Report Page - GET Route
app.get('/admin/salestaxreport', (req, res) => {
    // Admin access check
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
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
    // Admin access check
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
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
                
                // Calculate total gross receipts from all invoices, regardless of sales tax
                if (invoiceDate.isBetween(start, end, undefined, '[]')) {
                    totalGrossReceipts += invoice.totalAmount;

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

// Route for Admin Sales By Product Report
app.get('/admin/salesbyproductreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('salesreport', { reportData: null, month: null });
});

app.post('/admin/salesbyproductreport', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }

    const selectedMonth = req.body.month; // Format: YYYY-MM
    const startOfMonth = moment(selectedMonth, 'YYYY-MM').startOf('month');
    const endOfMonth = moment(selectedMonth, 'YYYY-MM').endOf('month');
    const startOfLastMonth = moment(selectedMonth, 'YYYY-MM').subtract(1, 'month').startOf('month');
    const endOfLastMonth = moment(selectedMonth, 'YYYY-MM').subtract(1, 'month').endOf('month');

    let reportData = {};

    // Iterate through all users and their invoices to gather sales data
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                const invoiceDate = moment(invoice.dateCreated, 'YYYY-MM-DD');
                const isCurrentMonth = invoiceDate.isBetween(startOfMonth, endOfMonth, undefined, '[]');
                const isLastMonth = invoiceDate.isBetween(startOfLastMonth, endOfLastMonth, undefined, '[]');

                invoice.products.forEach(product => {
                    if (!reportData[product.productName]) {
                        reportData[product.productName] = {
                            productName: product.productName,
                            quantitySold: 0,
                            quantitySoldLastMonth: 0,
                            totalAmount: 0,
                            totalAmountLastMonth: 0,
                            rate: product.rate
                        };
                    }

                    if (isCurrentMonth) {
                        reportData[product.productName].quantitySold += product.quantity;
                        reportData[product.productName].totalAmount += product.total;
                    }

                    if (isLastMonth) {
                        reportData[product.productName].quantitySoldLastMonth += product.quantity;
                        reportData[product.productName].totalAmountLastMonth += product.total;
                    }
                });
            });
        }
    });

    // Convert reportData object to an array and sort by totalAmount
    const reportDataArray = Object.values(reportData).sort((a, b) => b.totalAmount - a.totalAmount);

    res.render('salesreport', { reportData: reportDataArray, month: selectedMonth });
});

app.get('/admin/returns', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('returns-form');
});

app.post('/admin/returns', multerUpload.array('images', 10), (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
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
        return res.status(403).send('Access denied.');
    }

    const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    res.render('manage-returns', { returns: data.returns || [] });
});

app.get('/admin/manageReturns/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
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
