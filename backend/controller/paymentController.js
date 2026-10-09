const paymentConnection = require('../utils/paymentConnection');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { processOrder, deductDirectSaleStock } = require('./OrderController'); // Import processOrder
const util = require('util'); // Make sure this is at the top

// Create a payment intent
exports.createPaymentIntent = async (req, res) => {
    const { order_id } = req.body;
    const user_id = req.user.user_id;
    if (!order_id) {
        return res.status(400).json({ message: 'Order ID is required' });
    }
    const db = paymentConnection(req.db);

    try {
        await db.promise().beginTransaction();
        const [orderRows] = await db.promise().execute(
            `SELECT order_id, user_id, total_amount, order_status, payment_method
             FROM orders WHERE order_id = ? FOR UPDATE`,
            [order_id]
        );

        if (orderRows.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const order = orderRows[0];

        if (String(order.user_id) !== String(user_id)) {
            return res.status(403).json({ message: 'You can only pay for your own orders' });
        }

        if (['COMPLETED', 'CANCELLED', 'DONE'].includes(order.order_status)) {
            return res.status(400).json({ message: 'This order cannot be paid' });
        }

        if (order.payment_method !== 'CARD') {
            return res.status(400).json({ message: 'Only card orders can use Stripe' });
        }

        const amount = Number(order.total_amount);
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.round(amount * 100) <= 0) {
            return res.status(400).json({ message: 'Order has an invalid total' });
        }

        try {
            const [existing] = await db.promise().execute(
                'SELECT stripe_payment_intent_id FROM payments WHERE order_id = ? ORDER BY payment_id DESC LIMIT 1', [order_id]);
            if (existing.length) {
                const intent = await stripe.paymentIntents.retrieve(existing[0].stripe_payment_intent_id);
                if (intent.status === 'canceled' || intent.amount !== Math.round(amount * 100) || intent.currency !== 'usd') {
                    await db.promise().rollback();
                    return res.status(409).json({ message: 'Existing payment requires review' });
                }
                await db.promise().commit();
                return res.json({ clientSecret: intent.client_secret, amount });
            }
            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: 'usd',
                automatic_payment_methods: {
                    enabled: true,
                },
                metadata: {
                    order_id: String(order_id),
                    user_id: String(user_id)
                }
            }, { idempotencyKey: `order-${order_id}-${Math.round(amount * 100)}-usd` });

            await db.promise().execute(
                'INSERT INTO payments (order_id, amount, payment_status, stripe_payment_intent_id) VALUES (?, ?, ?, ?)',
                [order_id, amount, 'PENDING', paymentIntent.id]
            );

            await db.promise().execute(
                'UPDATE orders SET order_status = ? WHERE order_id = ?',
                ['PROCESSING', order_id]
            );

            await db.promise().commit();

            res.json({
                clientSecret: paymentIntent.client_secret,
                amount
            });
        } catch (error) {
            await db.promise().rollback();
            console.error('Error during payment intent creation:', error);
            res.status(500).json({ message: 'Payment creation failed'});
        }
    } catch (error) {
        console.error('Top-level payment intent creation error:', error);
        res.status(500).json({ message: 'Error creating payment intent'});
    } finally {
        // Rollback also releases locks on early validation returns.
        await db.promise().rollback();
        db.end();
    }
};

// Stripe retries unsuccessful deliveries; the same locked confirmation path is
// safe for both webhook retries and the browser's confirmation request.
exports.handleWebhook = async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).json({ message: 'Payment webhook is not configured' });
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        return res.status(400).json({ message: 'Invalid webhook signature' });
    }
    if (event.type !== 'payment_intent.succeeded') return res.json({ received: true });
    const intent = event.data.object;
    return exports.confirmPayment({
        db: req.db,
        body: { order_id: intent.metadata.order_id },
        params: { paymentIntentId: intent.id },
        user: { user_id: intent.metadata.user_id }
    }, res);
};

// // Handle webhook events from Stripe
// exports.handleWebhook = async (req, res) => {
//     const sig = req.headers['stripe-signature'];
//     const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

//     let event;

//     try {
//         event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
//     } catch (err) {
//         console.error('Webhook signature verification failed:', err.message);
//         return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     const db = req.db;

//     // Handle the event
//     switch (event.type) {
//         case 'payment_intent.succeeded':
//             const paymentIntent = event.data.object;
//             try {
//                 await db.promise().beginTransaction();

//                 // Update payment status
//                 await db.promise().execute(
//                     'UPDATE payments SET payment_status = ? WHERE stripe_payment_intent_id = ?',
//                     ['COMPLETED', paymentIntent.id]
//                 );

//                 // Get order details
//                 const [orderRows] = await db.promise().execute(
//                     'SELECT order_type FROM orders WHERE order_id = ?',
//                     [paymentIntent.metadata.order_id]
//                 );

//                 if (orderRows.length > 0) {
//                     const order = orderRows[0];
                    
//                     if (order.order_type === 'DIRECT_SALE') {
//                         // For direct sales, update inventory immediately
//                         const [orderProducts] = await db.promise().execute(
//                             'SELECT product_id, quantity FROM order_product WHERE order_id = ?',
//                             [paymentIntent.metadata.order_id]
//                         );

//                         for (const item of orderProducts) {
//                             await db.promise().execute(
//                                 'UPDATE product SET stock_quantity = stock_quantity - ? WHERE product_id = ?',
//                                 [item.quantity, item.product_id]
//                             );
//                         }

//                         // Update order status to completed for direct sales
//                         await db.promise().execute(
//                             'UPDATE orders SET order_status = ? WHERE order_id = ?',
//                             ['COMPLETED', paymentIntent.metadata.order_id]
//                         );
//                     } else {
//                         // For production orders, create production order entry
//                         const [orderProducts] = await db.promise().execute(
//                             'SELECT product_id FROM order_product WHERE order_id = ? LIMIT 1',
//                             [paymentIntent.metadata.order_id]
//                         );

//                         if (orderProducts.length > 0) {
//                             const [recipeRows] = await db.promise().execute(
//                                 'SELECT recipe_id FROM recipe WHERE product_id = ?',
//                                 [orderProducts[0].product_id]
//                             );

//                             if (recipeRows.length > 0) {
//                                 await db.promise().execute(
//                                     'INSERT INTO production_orders (order_id, recipe_id, production_status, start_time) VALUES (?, ?, ?, NOW())',
//                                     [paymentIntent.metadata.order_id, recipeRows[0].recipe_id, 'PENDING']
//                                 );
//                             }
//                         }

//                         // Update order status to DONE for production orders
//                         await db.promise().execute(
//                             'UPDATE orders SET order_status = ? WHERE order_id = ?',
//                             ['DONE', paymentIntent.metadata.order_id]
//                         );
//                     }
//                 }

//                 await db.promise().commit();
//             } catch (error) {
//                 await db.promise().rollback();
//                 console.error('Error processing payment success:', error);
//             }
//             break;

//         case 'payment_intent.payment_failed':
//             try {
//                 await db.promise().beginTransaction();

//                 // Update payment status
//                 await db.promise().execute(
//                     'UPDATE payments SET payment_status = ? WHERE stripe_payment_intent_id = ?',
//                     ['FAILED', paymentIntent.id]
//                 );

//                 // Update order status
//                 await db.promise().execute(
//                     'UPDATE orders SET order_status = ? WHERE order_id = ?',
//                     ['CANCELLED', paymentIntent.metadata.order_id]
//                 );

//                 await db.promise().commit();
//             } catch (error) {
//                 await db.promise().rollback();
//                 console.error('Error processing payment failure:', error);
//             }
//             break;

//         default:
//             console.log(`Unhandled event type ${event.type}`);
//     }

//     res.json({ received: true });
// };

// Get all payments (Admin only)
exports.getAllPayments = async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin' && req.user.role !== 'cashier') {
            return res.status(403).json({ message: 'Access denied. Admin only.' });
        }

        const db = req.db;
        
        const [payments] = await db.promise().execute(`
            SELECT 
                p.*,
                o.order_type,
                o.order_status,
                u.first_name as customer_name
            FROM payments p
            JOIN orders o ON p.order_id = o.order_id
            LEFT JOIN user u ON o.user_id = u.user_id
            ORDER BY p.transaction_date DESC
        `);

        res.json({
            success: true,
            payments: payments
        });
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error fetching payments',
            error: error.message 
        });
    }
};

// Get payment statistics (Admin only)
exports.getPaymentStatistics = async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin' && req.user.role !== 'cashier') {
            return res.status(403).json({ message: 'Access denied. Admin only.' });
        }

        const db = req.db;
        const { startDate, endDate } = req.query;

        let dateFilter = '';
        let params = [];
        
        if (startDate && endDate) {
            dateFilter = 'WHERE p.transaction_date BETWEEN ? AND ?';
            params = [startDate, endDate];
        }

        // Get overall statistics
        const [stats] = await db.promise().execute(`
            SELECT 
                COUNT(*) as total_transactions,
                SUM(CASE WHEN payment_status = 'COMPLETED' THEN amount ELSE 0 END) as total_revenue,
                COUNT(CASE WHEN payment_status = 'COMPLETED' THEN 1 END) as successful_payments,
                COUNT(CASE WHEN payment_status = 'FAILED' THEN 1 END) as failed_payments,
                COUNT(CASE WHEN payment_status = 'PENDING' THEN 1 END) as pending_payments
            FROM payments p
            ${dateFilter}
        `, params);

        // Get payment method distribution
        const [methodStats] = await db.promise().execute(`
            SELECT 
                payment_method,
                COUNT(*) as count,
                SUM(amount) as total_amount
            FROM payments p
            ${dateFilter}
            GROUP BY payment_method
        `, params);

        // Get daily transaction summary
        const [dailyStats] = await db.promise().execute(`
            SELECT 
                DATE(transaction_date) as date,
                COUNT(*) as transactions,
                SUM(amount) as total_amount,
                COUNT(CASE WHEN payment_status = 'COMPLETED' THEN 1 END) as successful,
                COUNT(CASE WHEN payment_status = 'FAILED' THEN 1 END) as failed
            FROM payments p
            ${dateFilter}
            GROUP BY DATE(transaction_date)
            ORDER BY date DESC
            LIMIT 30
        `, params);

        res.json({
            success: true,
            statistics: {
                overall: stats[0],
                paymentMethods: methodStats,
                dailyTransactions: dailyStats
            }
        });
    } catch (error) {
        console.error('Error fetching payment statistics:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error fetching payment statistics',
            error: error.message 
        });
    }
};

// Confirm payment manually
exports.confirmPayment = async (req, res) => {
    const { order_id } = req.body;
    const paymentIntentId = req.params.paymentIntentId;
    if (!order_id || !paymentIntentId) {
        return res.status(400).json({ message: 'Order ID and payment intent are required' });
    }
    let db;
    let inTransaction = false;
    try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') {
            return res.status(400).json({ message: 'Payment has not succeeded' });
        }
        if (String(intent.metadata.order_id) !== String(order_id)) {
            return res.status(400).json({ message: 'Payment does not match this order' });
        }
        db = paymentConnection(req.db);
        await db.promise().beginTransaction();
        inTransaction = true;
        const [orders] = await db.promise().execute(
            'SELECT order_id, user_id, order_type, order_status, total_amount, payment_method FROM orders WHERE order_id = ? FOR UPDATE', [order_id]);
        const reject = async (status, message) => {
            await db.promise().rollback();
            inTransaction = false;
            return res.status(status).json({ message });
        };
        if (!orders.length) return await reject(404, 'Order not found');
        const order = orders[0];
        if (String(order.user_id) !== String(req.user.user_id)) {
            return await reject(403, 'You can only confirm your own orders');
        }
        const [payments] = await db.promise().execute(
            'SELECT payment_id, payment_status, amount FROM payments WHERE stripe_payment_intent_id = ? AND order_id = ? FOR UPDATE',
            [paymentIntentId, order_id]);
        if (!payments.length) return await reject(404, 'Payment record not found');
        const expected = Math.round(Number(order.total_amount) * 100);
        if (order.payment_method !== 'CARD' || !Number.isSafeInteger(expected) || expected <= 0 ||
            intent.currency !== 'usd' || intent.amount !== expected || intent.amount_received !== expected ||
            String(intent.metadata.user_id) !== String(order.user_id) ||
            payments.some(payment => Math.round(Number(payment.amount) * 100) !== expected)) {
            return await reject(400, 'Payment amount, currency or owner does not match the order');
        }
        if (payments.some(payment => payment.payment_status === 'COMPLETED')) {
            await db.promise().commit();
            inTransaction = false;
            return res.json({ success: true, message: 'Payment already confirmed' });
        }
        const [completed] = await db.promise().execute(
            "SELECT payment_id FROM payments WHERE order_id = ? AND payment_status = 'COMPLETED'", [order_id]);
        if (completed.length || ['COMPLETED', 'DONE', 'CANCELLED'].includes(order.order_status)) {
            return await reject(409, 'Order cannot be fulfilled again');
        }
        if (order.order_type === 'DIRECT_SALE') {
            await deductDirectSaleStock(db, order_id);
        } else if (order.order_type === 'PRODUCTION_ORDER') {
            await processOrder({ query: util.promisify(db.query).bind(db) }, order_id);
        } else {
            return await reject(400, 'Unsupported order type');
        }
        await db.promise().execute('UPDATE orders SET order_status = ? WHERE order_id = ?',
            [order.order_type === 'DIRECT_SALE' ? 'COMPLETED' : 'DONE', order_id]);
        await db.promise().execute('UPDATE payments SET payment_status = ? WHERE stripe_payment_intent_id = ? AND order_id = ?',
            ['COMPLETED', paymentIntentId, order_id]);
        await db.promise().commit();
        inTransaction = false;
        return res.json({ success: true, message: 'Payment confirmed successfully' });
    } catch (error) {
        if (inTransaction) await db.promise().rollback();
        console.error('Error confirming payment:', error);
        return res.status(500).json({ message: 'Error confirming payment' });
    } finally {
        if (db) db.end();
    }
};

// Get detailed payment information by ID
exports.getPaymentDetails = async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin' && req.user.role !== 'cashier') {
            return res.status(403).json({ message: 'Access denied. Admin only.' });
        }

        const { id } = req.params;
        const db = req.db;
        
        // Get payment details with order and user information
        const [paymentDetails] = await db.promise().execute(`
            SELECT 
                p.*,
                o.order_type,
                o.order_status,
                o.date as order_date,
                o.total_amount as order_total,
                u.first_name,
                u.last_name,
                u.email,
                u.phone_number,
                (
                    SELECT GROUP_CONCAT(
                        JSON_OBJECT(
                            'product_name', pr.product_name,
                            'quantity', op.quantity,
                            'unit_price', pr.selling_price,
                            'subtotal', (pr.selling_price * op.quantity)
                        )
                    )
                    FROM order_product op
                    JOIN product pr ON op.product_id = pr.product_id
                    WHERE op.order_id = p.order_id
                ) as order_items
            FROM payments p
            JOIN orders o ON p.order_id = o.order_id
            LEFT JOIN user u ON o.user_id = u.user_id
            WHERE p.payment_id = ?
        `, [id]);

        if (!paymentDetails[0]) {
            return res.status(404).json({ 
                success: false,
                message: 'Payment not found' 
            });
        }

        // Parse the order items JSON string
        if (paymentDetails[0].order_items) {
            try {
                // Split by comma but handle escaped commas within JSON
                const itemStrings = paymentDetails[0].order_items.match(/({[^}]+})/g) || [];
                const itemsArray = itemStrings.map(item => JSON.parse(item.trim()));
                paymentDetails[0].order_items = itemsArray;
            } catch (error) {
                console.error('Error parsing order items:', error);
                paymentDetails[0].order_items = [];
            }
        } else {
            paymentDetails[0].order_items = [];
        }

        res.json({
            success: true,
            payment: paymentDetails[0]
        });
    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error fetching payment details',
            error: error.message 
        });
    }
};

exports.getPaymentsByDateRange = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ 
                success: false, 
                message: 'Start date and end date are required' 
            });
        }

        const query = `
            SELECT 
                p.*,
                o.order_id,
                o.total_amount as order_amount
            FROM payments p
            LEFT JOIN orders o ON p.order_id = o.order_id
            WHERE p.transaction_date BETWEEN ? AND ?
            ORDER BY p.transaction_date DESC
        `;

        const [payments] = await req.db.promise().query(query, [startDate, endDate]);

        // Calculate total amount
        const totalAmount = payments.reduce((sum, payment) => sum + parseFloat(payment.amount), 0);

        res.status(200).json({
            success: true,
            data: {
                payments,
                totalAmount,
                paymentCount: payments.length
            }
        });
    } catch (error) {
        console.error('Error fetching payments by date range:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching payments by date range',
            error: error.message 
        });
    }
}; 
