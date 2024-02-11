const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();

let users = []; // To include both admin and customer users
let inventory = [
    { id: 1, itemName: "Item One", quantity: 100, priceLevel1: 10, priceLevel2: 9, priceLevel3: 8, imageUrl: "/path/to/image1.jpg" },
    // Add more items as needed
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

// Initial Admin User Setup
bcrypt.hash('adminpass', 10, function(err, hash) {
    if (err) {
        console.error("Error hashing admin password", err);
    } else {
        users.push({ id: 1, email: "admin@example.com", password: hash, role: "admin" });
    }
});

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
    res.render('add-inventory');
});

app.post('/admin/add-inventory', (req, res) => {
    upload(req, res, (err) => {
        if (err) {
            res.send(err);
        } else {
            // Check if file is selected
            if (req.file == undefined) {
                res.send('Error: No file selected!');
            } else {
                const { itemName, quantity, priceLevel1, priceLevel2, priceLevel3 } = req.body;
                const imageUrl = '/uploads/' + req.file.filename;
                // Add the inventory item to the inventory array
                inventory.push({ 
                    id: inventory.length + 1, 
                    itemName, 
                    quantity: parseInt(quantity), 
                    priceLevel1: parseFloat(priceLevel1), 
                    priceLevel2: parseFloat(priceLevel2), 
                    priceLevel3: parseFloat(priceLevel3), 
                    imageUrl 
                });
                res.redirect('/admin/view-inventory');
            }
        }
    });
});

app.get('/admin/edit-inventory/:id', (req, res) => {
    if (!req.session.loggedIn || req.session.user.role !== 'admin') {
        return res.send('Unauthorized access.');
    }
    const item = inventory.find(item => item.id === parseInt(req.params.id));
    res.render('edit-inventory', { item });
});

app.post('/admin/edit-inventory/:id', (req, res) => {
    const { itemName, quantity, price } = req.body;
    const index = inventory.findIndex(item => item.id === parseInt(req.params.id));
    if (index !== -1) {
        inventory[index] = { id: parseInt(req.params.id), itemName, quantity: parseInt(quantity), price: parseFloat(price) };
    }
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
        // Ensure that the price property is set before adding the item to the cart
        if (!item.price) {
            // Retrieve the price based on the user's price level
            const userPriceLevel = req.session.user.priceLevel || '3'; // Default to price level 3 if not set
            item.price = item[`priceLevel${userPriceLevel}`];
        }
        // Check if the item is already in the cart
        const existingItem = req.session.cart.find(cartItem => cartItem.id == itemId);
        if (existingItem) {
            existingItem.quantity += parseInt(quantity, 10);
        } else {
            req.session.cart.push({...item, quantity: parseInt(quantity, 10)});
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
        invoices: []
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
function padNumber(num, size) {
    let padded = num.toString();
    while (padded.length < size) {
        padded = "0" + padded;
    }
    return padded;
}
function generateInvoiceNumber(user) {
    // Extract the company initials from the company name
    const companyInitials = user.company.split(' ').map(word => word[0]).join('').toUpperCase();
    // Generate the invoice number based on the length of the invoices array
    const invoiceNumber = companyInitials + padNumber(user.invoices.length + 1, 3); // Start with 001
    return invoiceNumber;
}


app.get('/checkout', (req, res) => {
    const cart = req.session.cart || []; // Assuming the cart data is stored in the session
    const user = req.session.user;
    // Generate the invoice number
    const invoiceNumber = generateInvoiceNumber(user);
    res.render('checkout', { invoiceNumber, cart });
});
app.post('/submit-order', (req, res) => {
    // Example: Process the order from the session cart
    const cart = req.session.cart || []; // Assuming the cart data is stored in the session
    const user = req.session.user;
    const getinvoiceNumber = generateInvoiceNumber(user);
    function calculateTotalAmount(cart) {
        // Calculate the total amount based on the items in the cart
        return cart.reduce((total, item) => total + (item.price * item.quantity), 0);
    }
    // Create an invoice object
    const invoice = {
        invoiceNumber: getinvoiceNumber, // Assuming you have a function to generate invoice numbers
        companyName: req.session.user.company,
        dateCreated: new Date(),
        products: req.session.cart.map(item => ({
            productName: item.itemName,
            quantity: item.quantity,
            rate: item.price
        })),
        totalBalance: calculateTotalAmount(req.session.cart),
        paid: false // Invoice is initially set to unpaid
    };

    // Add the invoice to the user's invoices array
    const userIndex = users.findIndex(user => user.id === req.session.user.id);
    if (userIndex !== -1) {
        users[userIndex].invoices.push(invoice);
        req.session.user.invoices = users[userIndex].invoices;
    } else {
        console.error('User not found.');
    }

    // Add the invoice to the invoices array
    invoices.push(invoice);
    console.log(invoice);
    // Clear the cart after submitting the order
    req.session.cart = [];
    res.send('Order submitted successfully. Thank you!');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
