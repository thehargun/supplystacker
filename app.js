const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const pdfService = require('./services/pdfService');
const emailService = require('./services/emailService');
const fs = require('fs');
const app = express();

let users = []; // To include both admin and customer users
let inventory = [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, imageUrl: "/path/to/image1.jpg" },
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
    res.locals.req = req; // Make `req` available in EJS views
    next();
});
const multer = require('multer');
const path = require('path');
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function(req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Init upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 1000000 }, // 1 MB
    fileFilter: function(req, file, cb) {
        checkFileType(file, cb);
    }
}).single('image');

// Check file type
function checkFileType(file, cb) {
    // Allowed extensions
    const filetypes = /jpeg|jpg|png|gif/;
    // Check extension
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    // Check mime
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

    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            user.invoices.forEach(invoice => {
                let invoiceInfo = {
                    userId: user.id,
                    userEmail: user.email,
                    priceLevel: user.priceLevel,
                    invoiceNumber: invoice.invoiceNumber,
                    totalBalance: invoice.totalBalance,
                    paid: invoice.paid,
                    dateCreated: invoice.dateCreated,
                    products: invoice.products
                };
                invoices.push(invoiceInfo);
            });
        }
    });
    
} catch (error) {
      console.log('No existing data found, starting with empty arrays.');
    }
  }
  
  loadData();
  setInterval(saveData, 10000);

// Check if an admin user already exists
const adminExists = users.some(user => user.email === "admin@example.com");
if (!adminExists) {
    bcrypt.hash('adminpass', 10, function(err, hash) {
        if (err) {
            console.error("Error hashing admin password", err);
        } else {
            users.push({ id: 1, email: "admin@example.com", password: hash, role: "admin" });
        }
    });
}

app.post('/admin/update-invoice/:invoiceNumber', (req, res) => {
    const { invoiceNumber } = req.params;
    const { dateCreated, totalBalance, products, customerId } = req.body;
    let numericTotalBalance = Number(totalBalance);

    // Ensure each product's quantity, rate, and total are numbers
    const numericProducts = products.map(product => ({
        ...product,
        quantity: Number(product.quantity),
        rate: parseFloat(product.rate),
        total: parseFloat(product.total)
    }));

    users.forEach(user => {
        if (user.id.toString() === customerId && Array.isArray(user.invoices)) {
            user.invoices.forEach(invoice => {
                if (invoice.invoiceNumber === invoiceNumber) {
                    invoice.dateCreated = dateCreated;
                    if (!isNaN(numericTotalBalance)) {
                        invoice.totalBalance = parseFloat(numericTotalBalance.toFixed(2));
                    } else {
                        console.log('totalBalance is not a number:', totalBalance);
                    }
                    invoice.products = numericProducts; // Update with numeric values
                }
            });
        }
    });

    invoices.forEach(invoice => {
        if (invoice.userId.toString() === customerId) {
            if (invoice.invoiceNumber === invoiceNumber) {
                invoice.dateCreated = dateCreated;
                if (!isNaN(numericTotalBalance)) {
                    invoice.totalBalance = parseFloat(numericTotalBalance.toFixed(2));
                } else {
                    console.log('totalBalance is not a number:', totalBalance);
                }
                invoice.products = numericProducts; // Update with numeric values
            }
        }
    });

    res.redirect(`/admin/customer-invoices/${customerId}`);
});




function saveData() {
    const data = {
      users: users,
      inventory: inventory,
    };
    fs.writeFileSync('data.json', JSON.stringify(data), 'utf8');
  }

// Routes
app.get('/', (req, res) => {
    res.render('login', { registerButton: true }); // Pass registerButton as true to display the register button
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(user => user.email === email); // Search in the users array
    if (user) {
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.user = { ...user };
            req.session.loggedIn = true;
            // Redirect based on user role
            if (user.role === 'admin') {
                res.redirect('/admin');
            } else {
                res.redirect('/products');
            }
        } else {
            // Redirect to login page with error message
            res.render('login', { errorMessage: 'Invalid credentials.' });
        }
    } else {
        // Redirect to login page with error message
        res.render('login', { errorMessage: 'User not found.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Admin Dashboard
app.get('/admin', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('admin');
});

// Inventory Management
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
    console.log(inventory);
    res.render('add-inventory', { inventory: inventory });
});


app.post('/admin/add-inventory', upload, (req, res) => {
    if (req.file == undefined) {
        return res.send('Error: No file selected!');
    }

    let { itemName, itemCategory, otherCategory, quantity, cost, priceLevel1, priceLevel2, priceLevel3 } = req.body;
    const imageUrl = '/uploads/' + req.file.filename;
    
    // Use the 'otherCategory' if 'itemCategory' is "Other"
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

    // Get current item
    const currentItem = inventory[itemIndex];

    // Update fields if provided in the request body
    currentItem.itemName = req.body.itemName || currentItem.itemName;
    currentItem.itemCategory = req.body.itemCategory || currentItem.itemCategory;
    currentItem.cost = req.body.cost ? parseFloat(req.body.cost) : currentItem.cost;
    currentItem.quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : currentItem.quantity;
    currentItem.priceLevel1 = req.body.priceLevel1 ? parseFloat(req.body.priceLevel1) : currentItem.priceLevel1;
    currentItem.priceLevel2 = req.body.priceLevel2 ? parseFloat(req.body.priceLevel2) : currentItem.priceLevel2;
    currentItem.priceLevel3 = req.body.priceLevel3 ? parseFloat(req.body.priceLevel3) : currentItem.priceLevel3;
    
    // If a new file is uploaded, update the imageUrl, otherwise keep the current one
    if (req.file) {
        const newImageUrl = '/uploads/' + req.file.filename;
        currentItem.imageUrl = newImageUrl;
    }

    // Replace the old item with the updated item
    inventory[itemIndex] = currentItem;

    // Redirect to the inventory list
    res.redirect('/admin/view-inventory');
});

app.get('/admin/delete-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    inventory = inventory.filter(item => item.id !== parseInt(req.params.id));
    res.redirect('/admin/view-inventory');
});

// Customer Management
app.get('/admin/view-customers', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.'); // Return a 403 Forbidden status
    }
    res.render('view-customers', { customers: users });
});
app.get('/admin/add-customer', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.'); // Return a 403 Forbidden status
    }
    res.render('add-customer');
});

app.post('/admin/add-customer', async (req, res) => {
    // Check if the user is logged in and is an admin
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.'); // Return a 403 Forbidden status
    }

    // Get customer details from the request body
    const { email, password, company, phone, addressLine1, addressLine2, city, state, zipCode, priceLevel } = req.body;

    // Hash the provided password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new customer object
    const newCustomer = {
        id: users.length + 1, // Generate a unique ID (you may use a different method)
        email,
        password: hashedPassword, // Store the hashed password
        company,
        phone,
        addressLine1,
        addressLine2,
        city,
        state,
        zipCode,
        priceLevel,
        role: 'customer', // Set the role to 'customer'
        invoices:[]
    };

    // Push the new customer to the 'users' array
    users.push(newCustomer);

    // Redirect to the "View Customers" page
    res.redirect('/admin/view-customers');
});
// ... (previous code)

// Products and Cart
app.get('/products', (req, res) => {
    if (!req.session.loggedIn) return res.send('Please log in.');
    
    const userPriceLevel = req.session.user.priceLevel || '3'; // Default to price level 3 if not set
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
        const userPriceLevel = req.session.user.priceLevel || '3'; // Default to price level 3 if not set
        const price = item[`priceLevel${userPriceLevel}`]; // Correctly determine price based on price level

        const existingItemIndex = req.session.cart.findIndex(cartItem => cartItem.id == itemId);
        if (existingItemIndex !== -1) {
            // If item already exists in cart, update the quantity
            req.session.cart[existingItemIndex].quantity += parseInt(quantity, 10);
        } else {
            // Add a new item to the cart with the correct price and quantity
            req.session.cart.push({
                ...item,
                quantity: parseInt(quantity, 10),
                price // Only store the calculated price
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

    // Assign a default price level of 3 for new registrations
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
        role: 'customer', // Default role is customer
        priceLevel: 3, // Default price level
        invoices: [],
        lastInvoiceNumber: 0
    };

    users.push(newUser);
    res.redirect('/'); // Redirect to login/home page
});
// GET request to display the edit customer form
app.get('/admin/edit-customer/:id', (req, res) => {
    const customerId = parseInt(req.params.id);
    console.log('Requested Customer ID:', customerId);
    console.log('Users Array:', users);
    const customer = users.find(user => user.id === customerId);
    console.log('Found Customer:', customer);
    if (!customer) {
        return res.send('Customer not found.');
    }
    res.render('edit-customer', { customer });
});

app.post('/admin/edit-customer/:id', async (req, res) => {
    const customerId = parseInt(req.params.id);
    console.log('Requested Customer ID:', customerId);
    console.log('Users Array:', users);

    // Retrieve the updated customer details from the form submission
    const updatedCustomer = {
        id: customerId,
        email: req.body.email,
        // Check if a new password is provided
        password: req.body.password ? await bcrypt.hash(req.body.password, 10) : undefined,
        company: req.body.company,
        phone: req.body.phone,
        addressLine1: req.body.addressLine1,
        addressLine2: req.body.addressLine2,
        city: req.body.city,
        state: req.body.state,
        zipCode: req.body.zipCode,
        priceLevel: parseInt(req.body.priceLevel), // Convert to integer
    };

    // Update the customer in the users array
    const index = users.findIndex(customer => customer.id === customerId);
    if (index === -1) {
        return res.send('Customer not found.');
    }
    users[index] = updatedCustomer;

    // Redirect to view customers page
    res.redirect('/admin/view-customers');
});
app.get('/admin/invoices', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied.');
    }
    res.render('invoices', { invoices });
});
app.post('/add-to-cart', (req, res) => {
    const { itemId, quantity } = req.body;
    if (!req.session.cart) {
        req.session.cart = [];
    }
    const item = inventory.find(item => item.id === parseInt(itemId));
    if (item) {
        // Check if the item is already in the cart
        const existingItemIndex = req.session.cart.findIndex(cartItem => cartItem.id === parseInt(itemId));
        if (existingItemIndex !== -1) {
            // If item already exists in cart, update the quantity
            req.session.cart[existingItemIndex].quantity += parseInt(quantity, 10);
        } else {
            // If item does not exist in cart, add it
            req.session.cart.push({...item, quantity: parseInt(quantity, 10)});
        }
        res.sendStatus(200); // Send success response
    } else {
        res.status(404).send('Item not found.'); // Send error response if item not found
    }
});
// Remove item from cart
app.delete('/remove-from-cart/:id', (req, res) => {
    const itemId = parseInt(req.params.id);
    if (!req.session.cart || !req.session.cart.length) {
        return res.status(400).send('Cart is empty.');
    }

    req.session.cart = req.session.cart.filter(item => item.id !== itemId);
    res.sendStatus(204); // No content
});

// Update item quantity in cart
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
    res.sendStatus(204); // No content
});
app.get('/get-total-amount', (req, res) => {
    // Calculate the total amount of the cart here
    // You can fetch cart data from session or database, then calculate the total amount

    // For demonstration purposes, assuming cart data is stored in req.session.cart
    let totalAmount = req.session.cart.reduce((total, item) => total + (item.price * item.quantity), 0);

    // Send the total amount as JSON response
    res.json({ totalAmount });
});
// Modify the generateInvoiceNumber function to accept the user object as an argument
function generateInvoiceNumber(company, lastInvoiceNumber) {
    // Check if lastInvoiceNumber is a number, if not, default to 0
    lastInvoiceNumber = typeof lastInvoiceNumber === 'number' ? lastInvoiceNumber : 0;
    lastInvoiceNumber += 1; // Increment lastInvoiceNumber
    const initials = company.split(' ').map(word => word[0]).join('').toUpperCase();
    return `${initials}${String(lastInvoiceNumber).padStart(2, '0')}`;
}


app.get('/checkout', (req, res) => {
    if (!req.session.user || !req.session.cart) {
        return res.status(400).send('User is not logged in or cart is empty.');
    }
    const cart = req.session.cart;
    // Ensure the user object has all necessary properties and an invoices array
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
    // Ensure the user's invoices is always an array
    user.invoices = user.invoices || [];
    
    // Update lastInvoiceNumber
    user.lastInvoiceNumber = user.lastInvoiceNumber ? user.lastInvoiceNumber + 1 : 1;
    
    const invoiceNumber = generateInvoiceNumber(user.company, user.lastInvoiceNumber);

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
        paid: false
    };

    // Push the new invoice into the user's invoices array
    user.invoices.push(invoiceDetails);
    
    // Find the user in the users array and update their details
    const userIndex = users.findIndex(u => u.id === user.id);
    if (userIndex !== -1) {
        users[userIndex] = user;
    } else {
        return res.status(404).send('User not found.');
    }

    // Also, update the session
    req.session.user = user;
    
    // Generate PDF Invoice
    // You need to implement this service or use an existing library to generate PDFs
    pdfService.generateInvoicePdf(invoiceDetails, pdfFilePath => {
        // Email the PDF Invoice
        // You need to implement this service or use an existing library to send emails
        emailService.sendOrderConfirmationWithInvoice('sales@supplystacker.com', invoiceDetails, pdfFilePath);

        // Clear the cart after submitting the order
        req.session.cart = [];

        // Send a response or render a template to inform the user
        res.render('order-submitted', { message: 'Order submitted successfully. Thank you!' });
    });
});

app.get('/admin/manage-payment', (req, res) => {
    // Render the manage payment page (manage-payment.ejs)
    res.render('manage-payment');
});
// Inside app.js

app.get('/admin/customer-invoices/:customerId', (req, res) => {
    const customerId = parseInt(req.params.customerId);
    console.log('Customer ID:', customerId); // Debugging log

    const customer = users.find(user => user.id === customerId);
    console.log('Customer:', customer); // Debugging log

    if (!customer) {
        return res.send('Customer not found.');
    }

    console.log('Invoices:', customer.invoices); // Debugging log

    if (!customer.invoices || customer.invoices.length === 0) {
        return res.send('No invoices for the company.');
    }
    

    res.render('customer-invoices', { invoices: customer.invoices, customerId });
});

app.get('/admin/invoice-details/:invoiceNumber', (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    console.log('Invoice Number:', invoiceNumber); // Debugging log

    // Assuming 'users' is an array of all users each containing an 'invoices' array
    let allInvoices = [];
    users.forEach(user => {
        if (user.invoices && user.invoices.length > 0) {
            allInvoices = allInvoices.concat(user.invoices);
        }
    });

    const invoice = allInvoices.find(invoice => invoice.invoiceNumber === invoiceNumber);
    if (!invoice) {
        return res.send('Invoice not found.');
    }

    console.log('Invoice Details:', invoice); // Debugging log

    // Render your invoice details page here, adjust 'invoice-details' to your template
    res.render('invoice-details', { invoice: invoice });
});

app.post('/admin/save-invoice-status', async (req, res) => {
    const { invoiceNumbers, paid } = req.body;
    let updatedInvoicesForUser = 0;
    let updatedInvoices = 0;

    users.forEach(user => {
        if (Array.isArray(user.invoices)) {
            user.invoices.forEach(invoice => {
                if (invoiceNumbers.includes(invoice.invoiceNumber)) {
                    invoice.paid = paid;
                    updatedInvoicesForUser++;
                }
            });
        }
    });

    invoices.forEach(invoice => {
        if (invoiceNumbers.includes(invoice.invoiceNumber)) {
            invoice.paid = paid;
            updatedInvoices++;
        }
    });

    // After updating the invoices, persist the changes back to data.json
    if (updatedInvoices > 0 && updatedInvoicesForUser > 0) {
        try {
            res.json({ message: `${updatedInvoices} Invoices updated successfully.` });
        } catch (err) {
            console.error('Failed to save or reload user data', err);
            res.status(500).json({ message: "Failed to update invoice status." });
        }
    } else {
        res.status(404).json({ message: "No matching invoices found." });
    }
});


app.get('/admin/edit-invoice/:invoiceNumber', (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    let foundInvoice = null;
    const customerId = req.query.customerId;

    users.forEach(user => {
        if (user.id.toString()  === customerId && Array.isArray(user.invoices)) {
            user.invoices.forEach(invoice => {
                if (invoice.invoiceNumber === invoiceNumber) {
                    foundInvoice = invoice;
                    return;
                }
            });
        }
    });

    if (foundInvoice && customerId) {
        res.render('edit-invoice', { invoice: foundInvoice, customerId });
    } else {
        res.status(404).send('Invoice not found');
    }
});




app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});



app.post('/submit-order', async (req, res) => {
    if (!req.session.cart || !req.session.user) {
        return res.send('No items in cart or user not logged in.');
    }

    const user = req.session.user;
    // Ensure the user's invoices is always an array
    user.invoices = user.invoices || [];
    const invoiceNumber = generateInvoiceNumber(user.company, user.invoices.length);

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
        paid: false
    };

    // Push the new invoice into the user's invoices array
    user.invoices.push(invoiceDetails);
    
    // Find the user in the users array and update their details
    const userIndex = users.findIndex(u => u.id === user.id);
    if (userIndex !== -1) {
        users[userIndex] = user;
    } else {
        return res.status(404).send('User not found.');
    }

    // Also, update the session
    req.session.user = user;
    
    // Generate PDF Invoice
    // You need to implement this service or use an existing library to generate PDFs
    pdfService.generateInvoicePdf(invoiceDetails, pdfFilePath => {
        // Email the PDF Invoice
        // You need to implement this service or use an existing library to send emails
        emailService.sendOrderConfirmationWithInvoice('contact@supplystacker.com', invoiceDetails, pdfFilePath);

        // Clear the cart after submitting the order
        req.session.cart = [];

        // Send a response or render a template to inform the user
        res.render('order-submitted', { message: 'Order submitted successfully. Thank you!' });
    });
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
