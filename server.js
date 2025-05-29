const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const app = express();
const PORT = 3003;
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'company_data',
    password: 'kolokol2',
    port: 5432
});
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.put('/api/update-quality-status', async (req, res) => {
    try {
        const { id, status, quality_score, notes } = req.body;
        if (!quality_score || isNaN(quality_score) || quality_score < 0 || quality_score > 10) {
            return res.status(400).json({ error: 'Quality score must be between 0 and 10.' });
        }
        if (!notes || notes.trim().length < 5) {
            return res.status(400).json({ error: 'Notes must be at least 5 characters long.' });
        }
        if (status === 'Completed') {
            return res.status(400).json({ error: 'You cannot save an order with status "Completed".' });
        }
        let finalStatus = status;
        if (status === 'Approved') {
            finalStatus = 'Completed and approved';
        }
        const orderData = await pool.query(`
            SELECT 
                po.id, 
                po.product_id,
                p.name AS product_name, 
                po.quantity,
                p.materials,
                ru.first_name || ' ' || ru.last_name AS responsible_user,
                cu.first_name || ' ' || cu.last_name AS control_user
            FROM production_orders po
            JOIN products p ON po.product_id = p.id
            LEFT JOIN users ru ON po.responsible_user_id = ru.id
            LEFT JOIN users cu ON po.responsible_for_control_user_id = cu.id
            WHERE po.id = $1
        `, [id]);
        if (orderData.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found.' });
        }
        const order = orderData.rows[0];
        await pool.query(
            `INSERT INTO workers_performance 
            (product_name, quantity, materials, responsible_user, control_user, quality_score, status, notes, created_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [order.product_name, order.quantity, JSON.stringify(order.materials),
                order.responsible_user, order.control_user, quality_score, finalStatus, notes]
        );
        if (finalStatus === 'Completed and approved') {
            const { product_id, quantity } = order;
            await pool.query(`
    INSERT INTO finished_goods_inventory (product_id, quantity)
    VALUES ($1, $2)
    ON CONFLICT (product_id)
    DO UPDATE SET quantity = finished_goods_inventory.quantity + EXCLUDED.quantity
  `, [product_id, quantity]);
            await pool.query(
                'DELETE FROM production_orders WHERE id = $1',
                [id]
            );
        } else {
            await pool.query(
                'UPDATE production_orders SET status = $1, notes = $2 WHERE id = $3',
                [finalStatus, notes, id]
            );
        }
        res.status(200).json({ message: 'Quality control updated successfully and saved to performance log.' });
    } catch (error) {
        console.error('Error updating quality control status:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/worker-performance', async (req, res) => {
    try {
        const { material, date_from, date_to } = req.query;
        let sql = `
			SELECT id, product_name, quantity,
				   materials::TEXT AS materials,
				   responsible_user, control_user,
				   quality_score, status, notes, created_at
			  FROM workers_performance
			 WHERE 1=1
		`;
        const params = [];
        if (material) {
            params.push(`%${material}%`);
            sql += ` AND materials::TEXT ILIKE $${params.length}`;
        }
        if (date_from) {
            params.push(date_from);
            sql += ` AND created_at >= $${params.length}`;
        }
        if (date_to) {
            params.push(date_to);
            sql += ` AND created_at <= $${params.length}`;
        }
        sql += ` ORDER BY created_at DESC`;
        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching worker performance data:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/worker-performance/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM workers_performance WHERE id = $1', [id]);
        res.status(200).json({ message: 'Worker performance record deleted successfully' });
    } catch (error) {
        console.error('Error deleting worker performance record:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/quality-control-orders/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT 
                po.id, 
                p.name AS product_name, 
                po.quantity,
                po.status,
                po.notes,
                ru.first_name AS responsible_first_name, 
                ru.last_name AS responsible_last_name
            FROM production_orders po
            JOIN products p ON po.product_id = p.id
            LEFT JOIN users ru ON po.responsible_user_id = ru.id
            WHERE po.responsible_for_control_user_id = $1 AND po.status = 'Completed'
            ORDER BY po.created_at DESC;
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching quality control orders:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/production-orders/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT 
                po.id, 
                p.name AS product_name, 
                po.quantity,
                jsonb_agg(jsonb_build_object(
                    'name', mat->>'name', 
                    'quantity', (mat->>'quantity')::TEXT || ' * ' || po.quantity || ' = ' ||
                    ((regexp_replace(mat->>'quantity', '[^0-9]', '', 'g'))::INTEGER * po.quantity) || ' ' ||
                    regexp_replace(mat->>'quantity', '[0-9]', '', 'g')
                )) AS materials,
                po.status,
                po.notes
            FROM production_orders po
            JOIN products p ON po.product_id = p.id
            LEFT JOIN LATERAL jsonb_array_elements(p.materials) mat ON true
            WHERE po.responsible_user_id = $1
            GROUP BY po.id, p.name, po.quantity, po.status, po.notes
            ORDER BY po.created_at DESC;
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching user production orders with materials:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-order-notes', async (req, res) => {
    try {
        const { id, notes } = req.body;
        await pool.query(
            'UPDATE production_orders SET notes = $1 WHERE id = $2',
            [notes, id]
        );
        res.status(200).json({ message: 'Order notes updated successfully' });
    } catch (error) {
        console.error('Error updating order notes:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-order-status', async (req, res) => {
    try {
        const { id, status } = req.body;
        await pool.query(
            'UPDATE production_orders SET status = $1 WHERE id = $2',
            [status, id]
        );
        res.status(200).json({ message: 'Order status updated successfully' });
    } catch (error) {
        console.error('Error updating order status:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-order', async (req, res) => {
    try {
        const { id, product_id, quantity, responsible_user_id, responsible_for_control_user_id } = req.body;
        await pool.query(
            'UPDATE production_orders SET product_id = $1, quantity = $2, responsible_user_id = $3, responsible_for_control_user_id = $4 WHERE id = $5',
            [product_id, quantity, responsible_user_id, responsible_for_control_user_id, id]
        );
        res.status(201).send('Production order updated successfully');
    } catch (error) {
        console.error('Error updating production order:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.first_name, u.last_name 
            FROM users u
            JOIN roles r ON u.role = r.role_name
            WHERE r.responsibilities @> $1
            ORDER BY u.first_name ASC
        `, ['["Perform production"]']);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching users with Perform Production duty:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-responsible', async (req, res) => {
    try {
        const { order_id, responsible_user_id } = req.body;
        await pool.query(
            'UPDATE production_orders SET responsible_user_id = $1 WHERE id = $2',
            [responsible_user_id, order_id]
        );
        res.status(201).send('Responsible person updated successfully');
    } catch (error) {
        console.error('Error updating responsible person:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY name ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, materials } = req.body;
        await pool.query('UPDATE products SET name = $1, materials = $2 WHERE id = $3', [name, JSON.stringify(materials), id]);
        for (const mat of materials) {
            await pool.query(`INSERT INTO material_costs (material_name, cost_per_unit) VALUES ($1, 0) ON CONFLICT (material_name) DO NOTHING`, [mat.name]);
        }
        await pool.query(`DELETE FROM material_costs WHERE material_name NOT IN (SELECT DISTINCT elem->>'name' FROM products, jsonb_array_elements(materials) AS elem)`);
        await pool.query(`
          DELETE FROM warehouse_inventory
           WHERE material_name NOT IN (
             SELECT DISTINCT elem->>'name'
               FROM products, jsonb_array_elements(materials) AS elem
           )
        `);
        res.status(200).json({ message: 'Product updated successfully' });
    } catch (error) {
        console.error('Error updating product:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/products', async (req, res) => {
    try {
        const { name, materials } = req.body;
        const exists = await pool.query('SELECT 1 FROM products WHERE name = $1', [name]);
        if (exists.rows.length) {
            return res.status(400).json({ error: 'Product with this name already exists' });
        }
        await pool.query('INSERT INTO products (name, materials) VALUES ($1, $2)', [name, JSON.stringify(materials)]);
        for (const mat of materials) {
            await pool.query(`INSERT INTO material_costs (material_name, cost_per_unit) VALUES ($1, 0) ON CONFLICT (material_name) DO NOTHING`, [mat.name]);
        }
        await pool.query(`DELETE FROM material_costs WHERE material_name NOT IN (SELECT DISTINCT elem->>'name' FROM products, jsonb_array_elements(materials) AS elem)`);
        await pool.query(`
          DELETE FROM warehouse_inventory
           WHERE material_name NOT IN (
             SELECT DISTINCT elem->>'name'
               FROM products, jsonb_array_elements(materials) AS elem
           )
        `);
        res.status(201).json({ message: 'Product created successfully' });
    } catch (error) {
        console.error('Error creating product:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const prodCheck = await pool.query('SELECT 1 FROM products WHERE id = $1', [id]);
        if (!prodCheck.rows.length) {
            return res.status(404).json({ error: 'Product not found' });
        }
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        await pool.query(`DELETE FROM material_costs WHERE material_name NOT IN (SELECT DISTINCT elem->>'name' FROM products, jsonb_array_elements(materials) AS elem)`);
        await pool.query(`
          DELETE FROM warehouse_inventory
           WHERE material_name NOT IN (
             SELECT DISTINCT elem->>'name'
               FROM products, jsonb_array_elements(materials) AS elem
           )
        `);
        res.status(201).json('Product deleted and orphan material costs cleaned up');
    } catch (error) {
        console.error('Error deleting product and cleaning material_costs:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/start-production', async (req, res) => {
    try {
        const { product_id, quantity, responsible_user_id, responsible_for_control_user_id } = req.body;
        const productQuery = await pool.query('SELECT * FROM products WHERE id = $1', [product_id]);
        if (productQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const product = productQuery.rows[0];
        let materials = Array.isArray(product.materials) ? product.materials : JSON.parse(product.materials);
        for (const material of materials) {
            const inventoryQuery = await pool.query('SELECT * FROM warehouse_inventory WHERE material_name = $1', [material.name]);
            if (inventoryQuery.rows.length === 0) {
                return res.status(400).json({ error: `Material ${material.name} is not available in warehouse` });
            }
            const currentQuantity = inventoryQuery.rows[0].quantity;
            const requiredQuantity = parseInt(material.quantity) * quantity;
            if (currentQuantity < requiredQuantity) {
                const existingRequest = await pool.query(
                    `SELECT * FROM purchase_requests WHERE material_name = $1 AND status = 'Pending'`,
                    [material.name]
                );
                if (existingRequest.rows.length > 0) {
                    const currentRequestQuantity = existingRequest.rows[0].quantity;
                    const newQuantity = currentRequestQuantity + requiredQuantity;
                    await pool.query(
                        `UPDATE purchase_requests SET quantity = $1 WHERE id = $2`,
                        [newQuantity, existingRequest.rows[0].id]
                    );
                } else {
                    const supplierQuery = await pool.query('SELECT id FROM suppliers LIMIT 1');
                    const supplier_id = supplierQuery.rows[0].id;
                    await pool.query(
                        `INSERT INTO purchase_requests (material_name, quantity, supplier_id, status) 
                         VALUES ($1, $2, $3, 'Pending')`,
                        [material.name, requiredQuantity, supplier_id]
                    );
                }
            }
        }
        await pool.query(
            `INSERT INTO production_orders 
            (product_id, quantity, responsible_user_id, responsible_for_control_user_id, status) 
            VALUES ($1, $2, $3, $4, $5)`,
            [product_id, quantity, responsible_user_id, responsible_for_control_user_id, 'Preparing']
        );
        for (const material of materials) {
            const inventoryQuery = await pool.query('SELECT * FROM warehouse_inventory WHERE material_name = $1', [material.name]);
            const currentQuantity = inventoryQuery.rows[0].quantity;
            const requiredQuantity = parseInt(material.quantity) * quantity;
            const newQuantity = currentQuantity - requiredQuantity;
            await pool.query(
                `UPDATE warehouse_inventory SET quantity = $1 WHERE material_name = $2`,
                [newQuantity, material.name]
            );
        }
        res.status(201).json({ message: 'Production started successfully' });
    } catch (error) {
        console.error('Error starting production:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/production-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                po.id, 
                p.name AS product_name, 
                po.quantity, 
                po.status, 
                po.notes,
                po.created_at,
                po.responsible_user_id,
                po.responsible_for_control_user_id,
                ru.first_name AS responsible_first_name, 
                ru.last_name AS responsible_last_name,
                cu.first_name AS control_first_name,
                cu.last_name AS control_last_name
            FROM production_orders po
            JOIN products p ON po.product_id = p.id
            LEFT JOIN users ru ON po.responsible_user_id = ru.id
            LEFT JOIN users cu ON po.responsible_for_control_user_id = cu.id
            ORDER BY po.created_at DESC;
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching production orders:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/control-users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.first_name, u.last_name 
            FROM users u
            JOIN roles r ON u.role = r.role_name
            WHERE r.responsibilities @> $1
            ORDER BY u.first_name ASC
        `, ['["Control product quality"]']);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching control users:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/production-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const orderData = await pool.query(`SELECT p.materials, po.quantity FROM production_orders po JOIN products p ON po.product_id = p.id WHERE po.id = $1
		`, [id]);
        if (orderData.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        const { materials, quantity: orderQty } = orderData.rows[0];
        const mats = Array.isArray(materials) ? materials : JSON.parse(materials);
        for (const mat of mats) {
            const perUnit = parseFloat(mat.quantity);
            if (isNaN(perUnit)) {
                console.warn(`Cannot parse quantity "${mat.quantity}" for material ${mat.name}`);
                continue;
            }
            const returnQty = perUnit * orderQty;
            const invRes = await pool.query(
                'SELECT quantity FROM warehouse_inventory WHERE material_name = $1',
                [mat.name]
            );
            if (invRes.rows.length === 0) {
                await pool.query(
                    `INSERT INTO warehouse_inventory (material_name, quantity)
					 VALUES ($1, $2)`,
                    [mat.name, returnQty]
                );
            } else {
                const currentQty = invRes.rows[0].quantity;
                const newQty = currentQty + returnQty;
                await pool.query(
                    `UPDATE warehouse_inventory SET quantity = $1 WHERE material_name = $2`,
                    [newQty, mat.name]
                );
            }
        }
        await pool.query('DELETE FROM production_orders WHERE id = $1', [id]);
        res.status(200).json({
            message: 'Production order deleted and materials returned to warehouse successfully'
        });
    } catch (error) {
        console.error(
            'Error deleting production order and updating warehouse inventory:',
            error.message
        );
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/purchase-history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const historyCheck = await pool.query('SELECT * FROM purchase_history WHERE id = $1', [id]);
        if (historyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase history record not found' });
        }
        await pool.query('DELETE FROM purchase_history WHERE id = $1', [id]);
        res.status(200).json({ message: 'Purchase history record deleted successfully' });
    } catch (error) {
        console.error('Error deleting purchase history record:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/control-users-supplies', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.first_name, u.last_name 
            FROM users u
            JOIN roles r ON u.role = r.role_name
            WHERE r.responsibilities @> $1
            ORDER BY u.first_name ASC
        `, ['["Procure quality control"]']);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching control users:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/purchase-requests/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT pr.id, pr.material_name, pr.quantity, pr.supplier, pr.status, pr.notes, pr.defect_report, pr.created_at
            FROM purchase_requests pr
            JOIN suppliers s ON pr.supplier_id = s.id
            WHERE s.control_user_id = $1
            ORDER BY pr.created_at DESC;
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching purchase requests for control user:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-defect-report', async (req, res) => {
    try {
        const { id, defect_report } = req.body;
        if (!defect_report || defect_report.trim().length < 5) {
            return res.status(400).json({ error: 'Defect report must be at least 5 characters long.' });
        }
        await pool.query(
            'UPDATE purchase_requests SET defect_report = $1 WHERE id = $2',
            [defect_report, id]
        );
        res.status(200).json({ message: 'Defect report updated successfully' });
    } catch (error) {
        console.error('Error updating defect report:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/purchase-requests', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, material_name, quantity, supplier, status, notes, defect_report, created_at
            FROM purchase_requests
            ORDER BY created_at DESC;
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching purchase requests:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/purchase-requests', async (req, res) => {
    try {
        const { material_name, quantity, supplier_id, notes } = req.body;
        const status = 'Pending';
        const supplierQuery = await pool.query('SELECT name, control_user_id FROM suppliers WHERE id = $1', [supplier_id]);
        if (supplierQuery.rows.length === 0) {
            return res.status(400).json({ error: 'Supplier not found' });
        }
        const supplier_name = supplierQuery.rows[0].name;
        const control_user_id = supplierQuery.rows[0].control_user_id;
        await pool.query(
            `INSERT INTO purchase_requests (material_name, quantity, supplier, supplier_id, status, notes) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [material_name, quantity, supplier_name, supplier_id, status, notes]
        );
        res.status(201).json({ message: 'Purchase request created successfully' });
    } catch (error) {
        console.error('Error creating purchase request:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/purchase-requests/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { material_name, quantity, supplier_id, notes } = req.body;
        const supplierQuery = await pool.query('SELECT name FROM suppliers WHERE id = $1', [supplier_id]);
        if (supplierQuery.rows.length === 0) {
            return res.status(400).json({ error: 'Supplier not found' });
        }
        const supplier_name = supplierQuery.rows[0].name;
        await pool.query(
            `UPDATE purchase_requests 
             SET material_name = $1, quantity = $2, supplier = $3, supplier_id = $4, notes = $5
             WHERE id = $6`,
            [material_name, quantity, supplier_name, supplier_id, notes, id]
        );
        res.status(200).json({ message: 'Purchase request updated successfully' });
    } catch (error) {
        console.error('Error updating purchase request:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/purchase-requests/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM purchase_requests WHERE id = $1', [id]);
        res.status(200).json({ message: 'Purchase request deleted successfully' });
    } catch (error) {
        console.error('Error deleting purchase request:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/suppliers/materials', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT jsonb_array_elements(materials)->>'name' AS material_name
            FROM products
        `);
        const materials = result.rows.map(row => row.material_name);
        res.json(materials);
    } catch (error) {
        console.error('Error fetching materials:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/materials', async (req, res) => {
    try {
        const result = await pool.query('SELECT materials FROM products');
        let uniqueMaterials = new Set();
        result.rows.forEach(row => {
            try {
                const materials = Array.isArray(row.materials) ? row.materials : JSON.parse(row.materials);
                materials.forEach(material => {
                    if (material && material.name) {
                        uniqueMaterials.add(material.name);
                    }
                });
            } catch (error) {
                console.error("Error parsing materials:", error.message);
            }
        });
        res.json([...uniqueMaterials]);
    } catch (error) {
        console.error('Error fetching materials:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/suppliers', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.name, s.contact_info, s.control_user_id,
                   u.first_name || ' ' || u.last_name AS control_user_name,
                   s.materials
            FROM suppliers s
            LEFT JOIN users u ON s.control_user_id = u.id
            ORDER BY s.name ASC;
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching suppliers:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/suppliers', async (req, res) => {
    try {
        const { name, contact_info, control_user_id, materials } = req.body;
        const existingSupplier = await pool.query('SELECT * FROM suppliers WHERE name = $1', [name]);
        if (existingSupplier.rows.length > 0) {
            return res.status(400).json({ error: 'Supplier with this name already exists' });
        }
        await pool.query(
            'INSERT INTO suppliers (name, contact_info, control_user_id, materials) VALUES ($1, $2, $3, $4)',
            [name, contact_info, control_user_id, materials]
        );
        res.status(201).json({ message: 'Supplier added successfully' });
    } catch (error) {
        console.error('Error adding supplier:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/suppliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, contact_info, control_user_id, materials } = req.body;
        const existingSupplier = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
        if (existingSupplier.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }
        const oldName = existingSupplier.rows[0].name;
        await pool.query(
            'UPDATE suppliers SET name = $1, contact_info = $2, control_user_id = $3, materials = $4 WHERE id = $5',
            [name, contact_info, control_user_id, `{${materials.join(',')}}`, id]
        );
        await pool.query(
            'UPDATE purchase_requests SET supplier = $1 WHERE supplier = $2',
            [name, oldName]
        );
        res.status(200).json({ message: 'Supplier updated successfully and purchase requests updated' });
    } catch (error) {
        console.error('Error updating supplier:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/suppliers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const supplierCheck = await pool.query('SELECT name FROM suppliers WHERE id = $1', [id]);
        if (supplierCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found' });
        }
        const supplierName = supplierCheck.rows[0].name;
        const purchaseCheck = await pool.query('SELECT COUNT(*) FROM purchase_requests WHERE supplier = $1', [supplierName]);
        if (parseInt(purchaseCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete supplier. It is used in purchase requests.' });
        }
        await pool.query('DELETE FROM suppliers WHERE id = $1', [id]);
        res.status(200).json({ message: 'Supplier deleted successfully' });
    } catch (error) {
        console.error('Error deleting supplier:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/active-purchase-requests', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, material_name, quantity, supplier, status, notes, created_at
            FROM purchase_requests
            WHERE status NOT IN ('Completed', 'Rejected')
            ORDER BY created_at DESC;
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching active purchase requests:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/active-purchase-requests/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(`
            SELECT pr.id, pr.material_name, pr.quantity, s.name AS supplier, pr.status, pr.notes, pr.created_at
            FROM purchase_requests pr
            JOIN suppliers s ON pr.supplier_id = s.id
            WHERE pr.status NOT IN ('Completed', 'Rejected')
              AND s.control_user_id = $1
            ORDER BY pr.created_at DESC;
        `, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching active purchase requests:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-purchase-status', async (req, res) => {
    try {
        const { id, status } = req.body;
        const validStatuses = ['Pending', 'In progress', 'Rejected', 'Completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status value' });
        }
        const orderQuery = await pool.query('SELECT * FROM purchase_requests WHERE id = $1', [id]);
        if (orderQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase request not found' });
        }
        const order = orderQuery.rows[0];
        await pool.query('UPDATE purchase_requests SET status = $1 WHERE id = $2', [status, id]);
        if (status === 'Completed') {
            await pool.query(
                `INSERT INTO purchase_history (material_name, quantity, supplier, status, notes, defect_report, completed_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [order.material_name, order.quantity, order.supplier, status, order.notes, order.defect_report]
            );
            await pool.query('DELETE FROM purchase_requests WHERE id = $1', [id]);
            const inventoryQuery = await pool.query('SELECT * FROM warehouse_inventory WHERE material_name = $1', [order.material_name]);
            if (inventoryQuery.rows.length === 0) {
                await pool.query(
                    `INSERT INTO warehouse_inventory (material_name, quantity) VALUES ($1, $2)`,
                    [order.material_name, order.quantity]
                );
            } else {
                const currentQuantity = inventoryQuery.rows[0].quantity;
                const newQuantity = currentQuantity + order.quantity;
                await pool.query(
                    `UPDATE warehouse_inventory SET quantity = $1 WHERE material_name = $2`,
                    [newQuantity, order.material_name]
                );
            }
        }
        res.status(200).json({ message: 'Purchase request status updated successfully' });
    } catch (error) {
        console.error('Error updating purchase request status:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/purchase-history', async (req, res) => {
    try {
        const { material, date_from, date_to } = req.query;
        let sql = `SELECT id, material_name, quantity, supplier, status, notes, defect_report, completed_at FROM purchase_history WHERE 1=1`;
        const params = [];
        if (material) {
            params.push(`%${material}%`);
            sql += ` AND material_name ILIKE $${params.length}`;
        }
        if (date_from) {
            params.push(date_from);
            sql += ` AND completed_at >= $${params.length}`;
        }
        if (date_to) {
            params.push(date_to);
            sql += ` AND completed_at <= $${params.length}`;
        }
        sql += ` ORDER BY completed_at DESC`;
        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching purchase history:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/warehouse-inventory', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT material_name, SUM(quantity) AS total_quantity
            FROM warehouse_inventory
            GROUP BY material_name
            ORDER BY material_name ASC;
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching warehouse inventory:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/employees', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users ORDER BY first_name ASC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching employees:", error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const employeeCheck = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (employeeCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.status(200).json({ message: 'Employee deleted successfully' });
    } catch (error) {
        console.error('Error deleting employee:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/update-employee', async (req, res) => {
    try {
        const { id, first_name, last_name, role, email, password } = req.body;
        if (!first_name || !last_name || !role || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        const roleQuery = await pool.query('SELECT role_name FROM roles WHERE id = $1', [role]);
        if (roleQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Role not found' });
        }
        const roleName = roleQuery.rows[0].role_name;
        await pool.query(
            `UPDATE users SET first_name = $1, last_name = $2, role = $3, email = $4, password = $5 WHERE id = $6`,
            [first_name, last_name, roleName, email, password, id]
        );
        res.status(200).json({ message: 'Employee updated successfully' });
    } catch (error) {
        console.error('Error updating employee:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error("Error fetching employee:", error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/roles', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, role_name AS name 
            FROM roles 
            ORDER BY role_name = 'No role' DESC, role_name ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching roles:", error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/search-workers', async (req, res) => {
    try {
        const { first_name, last_name, role, email } = req.query;
        let query = 'SELECT * FROM users WHERE 1=1';
        const values = [];
        let index = 1;
        if (first_name) {
            query += ` AND first_name ILIKE $${index}`;
            values.push(`%${first_name}%`);
            index++;
        }
        if (last_name) {
            query += ` AND last_name ILIKE $${index}`;
            values.push(`%${last_name}%`);
            index++;
        }
        if (role && role !== 'All roles') {
            query += ` AND role ILIKE $${index}`;
            values.push(`%${role}%`);
            index++;
        }
        if (email) {
            query += ` AND email ILIKE $${index}`;
            values.push(`%${email}%`);
            index++;
        }
        query += ` ORDER BY first_name ASC`;
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (error) {
        console.error('Error searching workers:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/employees', async (req, res) => {
    try {
        const { first_name, last_name, role, email } = req.body;
        const defaultPassword = '12345678';
        if (!first_name || !last_name || !role || !email ) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        const existingEmployee = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingEmployee.rows.length > 0) {
            return res.status(400).json({ error: 'Employee with this email already exists' });
        }
        await pool.query(
            `INSERT INTO users (first_name, last_name, role, email, password) 
            VALUES ($1, $2, $3, $4, $5)`,
            [first_name, last_name, role, email, defaultPassword]
        );
        res.status(201).json({ message: 'Employee added successfully' });
    } catch (error) {
        console.error('Error adding employee:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/rolestable', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM roles WHERE role_name <> 'No role' ORDER BY role_name ASC`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching roles:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/rolestable/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { role_name, responsibilities } = req.body;
        if (!role_name || typeof role_name !== 'string' || !role_name.trim()) {
            return res.status(400).json({ error: 'Role name is required.' });
        }
        if (!Array.isArray(responsibilities) || responsibilities.length === 0) {
            return res.status(400).json({ error: 'Responsibilities must be a non-empty array.' });
        }
        const result = await pool.query(`
      UPDATE roles
         SET role_name = $1,
             responsibilities = $2
       WHERE id = $3
    `, [role_name.trim(), JSON.stringify(responsibilities), id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Role not found.' });
        }
        res.status(200).json({ message: 'Role updated successfully.' });
    } catch (err) {
        console.error('Error updating role:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
const ALL_RESPONSIBILITIES = {
    'Production Department': [
        "Manage production processes",
        "Control product quality",
        "Monitor workers performance",
        "Perform production"
    ],
    'Supply and Logistics Department': [
        "Procure raw materials",
        "Procure quality control",
        "Monitor warehouse inventory"
    ],
    'HR Department': [
        "Recruit and hire employees"
    ],
    'Sales and Marketing Department': [
        "Analyze market and competitors",
        "Develop marketing campaigns",
        "Engage with customers and negotiate deals"
    ],
    'Finance and Economics Department': [
        "Calculate product cost",
        "Manage company budget"
    ]
};
app.get('/all-responsibilities', (req, res) => {
    res.json(ALL_RESPONSIBILITIES);
});
app.get('/api/rolestable/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM roles WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Role not found');
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});
app.delete('/api/rolestable/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `DELETE FROM roles WHERE id = $1`,
            [id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Role not found.' });
        }
        res.json({ message: 'Role deleted successfully.' });
    } catch (err) {
        console.error('Error deleting role:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/rolestable', async (req, res) => {
    try {
        const { role_name, responsibilities } = req.body;
        if (!role_name || typeof role_name !== 'string' || !role_name.trim()) {
            return res.status(400).json({ error: 'Role name is required.' });
        }
        if (!Array.isArray(responsibilities) || responsibilities.length === 0) {
            return res.status(400).json({ error: 'Please select at least one responsibility.' });
        }
        const result = await pool.query(
            `INSERT INTO roles (role_name, responsibilities) VALUES ($1, $2) RETURNING id, role_name, responsibilities`,
            [role_name.trim(), JSON.stringify(responsibilities)]
        );
        res.status(201).json({ message: 'Role created.', role: result.rows[0] });
    } catch (err) {
        console.error('Error creating role:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/competitors', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, name, website, industry, notes, rating FROM competitors ORDER BY name ASC`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching competitors:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/competitors', async (req, res) => {
    try {
        const { name, website, industry, notes } = req.body;
        if (!name || !name.trim())
            return res.status(400).json({ error: 'Name is required.' });
        await pool.query(
            `INSERT INTO competitors (name, website, industry, notes, rating) VALUES ($1, $2, $3, $4, 1)`,
            [name.trim(), website || null, industry || null, notes || '']
        );
        res.status(201).json({ message: 'Competitor added successfully.' });
    } catch (error) {
        console.error('Error creating competitor:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/competitors/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, website, industry, notes, rating } = req.body;
        if (!name || !name.trim())
            return res.status(400).json({ error: 'Name is required.' });
        if (rating != null && (isNaN(rating) || rating < 0 || rating > 5)) {
            return res.status(400).json({ error: 'Rating must be between 0 and 5.' });
        }
        const result = await pool.query(
            `UPDATE competitors SET name = $1, website = $2, industry = $3, notes = $4, rating = COALESCE($5, rating) WHERE id = $6`,
            [name.trim(), website || null, industry || null, notes || '', rating, id]
        );
        if (result.rowCount === 0)
            return res.status(404).json({ error: 'Competitor not found.' });
        res.json({ message: 'Competitor updated successfully.' });
    } catch (error) {
        console.error('Error updating competitor:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/competitors/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `DELETE FROM competitors WHERE id = $1`,
            [id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Competitor not found.' });
        }
        res.json({ message: 'Competitor deleted successfully.' });
    } catch (error) {
        console.error('Error deleting competitor:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.patch('/api/competitors/:id/rating', async (req, res) => {
    try {
        const { id } = req.params;
        const { rating } = req.body;
        if (rating == null || isNaN(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        }
        const result = await pool.query(
            `UPDATE competitors SET rating = $1 WHERE id = $2`,
            [rating, id]
        );
        if (result.rowCount === 0)
            return res.status(404).json({ error: 'Competitor not found.' });
        res.json({ message: 'Rating updated successfully.' });
    } catch (error) {
        console.error('Error updating rating:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/campaigns', async (req, res) => {
    const { name, channel, audience_segment, budget, start_date, end_date, status, notes = '' } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO campaigns (name, channel, audience_segment, budget, start_date, end_date, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING *`,
            [name, channel, audience_segment, budget, start_date, end_date, status, notes]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating campaign:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/campaigns', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching campaigns:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/campaigns/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching campaign:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/campaigns/:id', async (req, res) => {
    const { id } = req.params;
    const { name, channel, audience_segment, budget, start_date, end_date, status, notes = '' } = req.body;
    try {
        const result = await pool.query(
            `UPDATE campaigns SET name = $1, channel = $2, audience_segment = $3, budget = $4, start_date = $5, end_date = $6,
                status = $7, notes = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *`,
            [name, channel, audience_segment, budget, start_date, end_date, status, notes, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating campaign:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/campaigns/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM campaigns WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json({ message: 'Campaign deleted successfully' });
    } catch (error) {
        console.error('Error deleting campaign:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/campaigns/:id/notes', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            "SELECT id, note, created_by, created_at FROM campaign_notes WHERE campaign_id = $1 ORDER BY created_at DESC",
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching campaign notes:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/clients', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, name, company, email, phone, segment FROM clients ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/clients', async (req, res) => {
    const { name, company, email, phone, segment } = req.body;
    if (!name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const result = await pool.query(`
            INSERT INTO clients (name, company, email, phone, segment) VALUES ($1,$2,$3,$4,$5) RETURNING *
        `, [name, company, email, phone, segment]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM clients WHERE id = $1', [id]);
        res.json({ message: 'Client deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/clients/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query(`
            SELECT id, name, company, email, phone, segment FROM clients WHERE id = $1
        `, [id]);
        if (!rows.length) return res.status(404).json({ error: 'Client not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching client:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/clients/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, company, email, phone, segment } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const result = await pool.query(`
            UPDATE clients SET name = $1, company = $2, email = $3, phone = $4, segment = $5 WHERE id = $6 RETURNING id, name, company, email, phone, segment
        `, [name.trim(), company||null, email||null, phone||null, segment||null, id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating client:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/sales-orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
              so.id,
              p.name AS product_name,
              so.quantity,
              so.unit_price,
              so.total_price,
              c.name AS customer_name,
              so.status,
              u.first_name || ' ' || u.last_name AS responsible_name,
              so.created_at
            FROM sales_orders so
            JOIN products p ON so.product_id = p.id
            JOIN clients c ON so.customer_id = c.id
            JOIN users u ON so.responsible_id = u.id
            ORDER BY so.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/users-deals', async (req, res) => {
    const { rows } = await pool.query(`
		SELECT u.id, u.first_name, u.last_name FROM users u JOIN roles r ON u.role = r.role_name WHERE r.responsibilities @> $1 ORDER BY u.first_name
	`, ['["Engage with customers and negotiate deals"]']);
    res.json(rows);
});
app.post('/api/sales-orders', async (req, res) => {
    const { product_id, quantity, unit_price, customer_id, status, responsible_id } = req.body;
    if (!product_id || !quantity || !unit_price || !customer_id || !responsible_id) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const inv = await pool.query(
            `SELECT quantity FROM finished_goods_inventory WHERE product_id = $1`,
            [product_id]
        );
        if (!inv.rows[0] || inv.rows[0].quantity < quantity) {
            return res.status(400).json({ error: 'Insufficient stock' });
        }
        await pool.query(
            `UPDATE finished_goods_inventory SET quantity = quantity - $1 WHERE product_id = $2`,
            [quantity, product_id]
        );
        const insert = await pool.query(`
            INSERT INTO sales_orders (product_id, quantity, unit_price, customer_id, status, responsible_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [product_id, quantity, unit_price, customer_id, status, responsible_id]);
        res.status(201).json(insert.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/sales-orders/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const orderRes = await pool.query(
            'SELECT product_id, quantity FROM sales_orders WHERE id = $1',
            [id]
        );
        if (orderRes.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found' });
        }
        const { product_id, quantity } = orderRes.rows[0];
        const invRes = await pool.query(
            'SELECT quantity FROM finished_goods_inventory WHERE product_id = $1',
            [product_id]
        );
        if (invRes.rows.length > 0) {
            await pool.query(
                'UPDATE finished_goods_inventory SET quantity = quantity + $1 WHERE product_id = $2',
                [quantity, product_id]
            );
        } else {
            await pool.query(
                'INSERT INTO finished_goods_inventory (product_id, quantity) VALUES ($1, $2)',
                [product_id, quantity]
            );
        }
        await pool.query('DELETE FROM sales_orders WHERE id = $1', [id]);
        res.json({ message: 'Sales order deleted and inventory restored' });
    } catch (err) {
        console.error('Error deleting sales order:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/finished-goods-inventory', async (req, res) => {
    try {
        const result = await pool.query(`SELECT fgi.product_id, p.name AS product_name, fgi.quantity FROM finished_goods_inventory fgi JOIN products p ON fgi.product_id = p.id ORDER BY p.name ASC;`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching finished goods inventory:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/sales-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { product_id,quantity, unit_price, customer_id, status, responsible_id } = req.body;
        const oldRes = await pool.query(`SELECT product_id, quantity FROM sales_orders WHERE id = $1`, [id]);
        if (oldRes.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found' });
        }
        const old = oldRes.rows[0];
        await pool.query(
            `UPDATE finished_goods_inventory SET quantity = quantity + $1 WHERE product_id = $2`,
            [old.quantity, old.product_id]
        );
        const invRes = await pool.query(
            `SELECT quantity 
			   FROM finished_goods_inventory 
			  WHERE product_id = $1`,
            [product_id]
        );
        const invQty = invRes.rows[0]?.quantity || 0;
        if (invQty < quantity) {
            return res.status(400).json({ error: 'Insufficient stock to update order' });
        }
        await pool.query(
            `UPDATE finished_goods_inventory SET quantity = quantity - $1 WHERE product_id = $2`,
            [quantity, product_id]
        );
        if (status === 'Delivered') {
            await pool.query(
                `INSERT INTO completed_sales (product_id, quantity, unit_price, customer_id, status, responsible_id) VALUES ($1, $2, $3, $4, $5, $6)`,
                [ product_id, quantity, unit_price, customer_id, status, responsible_id ]
            );
            await pool.query(
                `DELETE FROM sales_orders WHERE id = $1`,
                [id]
            );
            return res.json({ message: 'Order delivered and moved to history' });
        }
        const upd = await pool.query(
            `UPDATE sales_orders SET product_id = $1, quantity = $2, unit_price = $3, customer_id = $4, status = $5, responsible_id = $6 WHERE id = $7 RETURNING *`,
            [product_id, quantity, unit_price, customer_id, status, responsible_id, id]
        );
        res.json(upd.rows[0]);
    } catch (err) {
        console.error('Error updating sales order:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/sales-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, product_id, quantity, unit_price, total_price, customer_id, status, responsible_id FROM sales_orders WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sales order not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching sales order:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/users/responsibility/:resp', async (req, res) => {
    try {
        const { resp } = req.params;
        const result = await pool.query(
            `SELECT u.id, u.first_name, u.last_name FROM users u JOIN roles r ON u.role = r.role_name WHERE r.responsibilities @> $1`,
            [JSON.stringify([resp])]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users by responsibility:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/completed-sales', async (req, res) => {
    try {
        const result = await pool.query(`
			SELECT 
				cs.id,
				cs.product_id,
				p.name AS product_name,
				cs.quantity,
				cs.unit_price,
				cs.total_price,
				cs.customer_id,
				c.name AS customer_name,
				cs.status,
				cs.responsible_id,
				u.first_name || ' ' || u.last_name AS responsible_name,
				cs.completed_at
			FROM completed_sales cs
			JOIN products p ON cs.product_id = p.id
			JOIN clients c ON cs.customer_id = c.id
			JOIN users u ON cs.responsible_id = u.id
			ORDER BY cs.completed_at DESC;
		`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching completed sales:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/completed-sales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM completed_sales WHERE id = $1', [id]);
        res.status(200).json({ message: 'Record deleted successfully' });
    } catch (error) {
        console.error('Error deleting completed sale:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/product-cost/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const prod = await pool.query(`SELECT materials FROM products WHERE id = $1`, [productId]);
        if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
        const materials = Array.isArray(prod.rows[0].materials) ? prod.rows[0].materials : JSON.parse(prod.rows[0].materials);
        const breakdown = [];
        let totalCost = 0;
        for (let m of materials) {
            const qtyPerUnit = parseFloat(m.quantity);
            const costRow = await pool.query(`SELECT cost_per_unit FROM material_costs WHERE material_name = $1`, [m.name]);
            const costPerUnit = costRow.rows[0]?.cost_per_unit ?? 0;
            const cost = qtyPerUnit * costPerUnit;
            breakdown.push({ material: m.name, qtyPerUnit, costPerUnit, cost });
            totalCost += cost;
        }
        res.json({ productId, breakdown, totalCost });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/material-costs', async (req, res) => {
    try {
        const result = await pool.query('SELECT material_name, cost_per_unit FROM material_costs ORDER BY material_name ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching material costs:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/material-costs/:material_name', async (req, res) => {
    const { material_name } = req.params;
    const { cost_per_unit } = req.body;
    if (isNaN(cost_per_unit) || cost_per_unit < 0) {
        return res.status(400).json({ error: 'Cost per unit must be a non-negative number.' });
    }
    try {
        const result = await pool.query('UPDATE material_costs SET cost_per_unit = $1 WHERE material_name = $2', [cost_per_unit, material_name]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Material not found.' });
        }
        res.json({ message: 'Material cost updated successfully' });
    } catch (error) {
        console.error('Error updating material cost:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/budgets', async (req, res) => {
    const budgets = await pool.query('SELECT * FROM budgets ORDER BY period_start DESC');
    res.json(budgets.rows);
});
app.post('/api/budgets', async (req, res) => {
    const { name, period_start, period_end, created_by, items } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO budgets (name, period_start, period_end, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
            [name, period_start, period_end, created_by]
        );
        const budgetId = rows[0].id;
        for (let it of items) {
            await client.query(
                `INSERT INTO budget_items (budget_id, parent_item_id, department, category, planned_amt) VALUES ($1,$2,$3,$4,$5)`,
                [budgetId, it.parent_item_id || null, it.department, it.category, it.planned_amt]
            );
        }
        await client.query('COMMIT');
        res.status(201).json({ id: budgetId });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error creating budget:', e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});
app.get('/api/budgets/:id/items', async (req, res) => {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM budget_items WHERE budget_id=$1 ORDER BY parent_item_id NULLS FIRST, department, category`, [id]);
    res.json(rows);
});
app.patch('/api/budget-items/:id/actual', async (req, res) => {
    const { id } = req.params;
    const { actual_amt } = req.body;
    await pool.query(`UPDATE budget_items SET actual_amt=$1 WHERE id=$2`, [actual_amt, id]);
    res.json({ success: true });
});
app.get('/api/forecasts', async (req, res) => {
    const { name } = req.query;
    try {
        let result;
        if (name) {
            result = await pool.query('SELECT * FROM forecast_scenarios WHERE name = $1', [name]);
        } else {
            result = await pool.query('SELECT * FROM forecast_scenarios ORDER BY created_at DESC');
        }
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching forecast scenarios:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.post('/api/forecasts', async (req, res) => {
    const client = await pool.connect();
    try {
        const { name, entries, created_by } = req.body;
        await client.query('BEGIN');
        const { rows } = await client.query(`INSERT INTO forecast_scenarios (name, created_by) VALUES ($1, $2) RETURNING id`, [name, created_by]);
        const forecastId = rows[0].id;
        const currentDate = new Date();
        const period = currentDate.toISOString().split('T')[0];
        for (const e of entries) {
            await client.query(`INSERT INTO forecast_entries (forecast_id, line_item, projected_value, period) VALUES ($1, $2, $3, $4)`, [forecastId, e.param_key, e.param_value, period]);
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Forecast created', id: forecastId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating forecast:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});
app.get('/api/forecasts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const forecastResult = await pool.query('SELECT * FROM forecast_scenarios WHERE id = $1', [id]);
        if (forecastResult.rows.length === 0) {
            return res.status(404).json({ error: 'Scenario not found' });
        }
        const scenario = forecastResult.rows[0];
        const entriesResult = await pool.query('SELECT line_item, projected_value, period FROM forecast_entries WHERE forecast_id = $1 ORDER BY period', [id]);
        res.json({
            id: scenario.id,
            name: scenario.name,
            created_at: scenario.created_at,
            entries: entriesResult.rows
        });
    } catch (error) {
        console.error('Error fetching forecast scenario:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/forecasts/:scenarioId', async (req, res) => {
    const { scenarioId } = req.params;
    try {
        const exist = await pool.query('SELECT 1 FROM forecast_scenarios WHERE id = $1', [scenarioId]);
        if (exist.rowCount === 0) {
            return res.status(404).json({ error: 'Scenario not found' });
        }
        await pool.query('DELETE FROM forecast_scenarios WHERE id = $1', [scenarioId]);
        res.status(204).send();
    } catch (err) {
        console.error('Error deleting forecast scenario:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.put('/api/forecasts/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { name, entries } = req.body;
        await client.query('BEGIN');
        await client.query(`UPDATE forecast_scenarios SET name = $1 WHERE id = $2`, [name, id]);
        await client.query(`DELETE FROM forecast_entries WHERE forecast_id = $1`, [id]);
        const currentDate = new Date();
        const period = currentDate.toISOString().split('T')[0];
        for (const e of entries) {
            await client.query(`INSERT INTO forecast_entries (forecast_id, line_item, projected_value, period) VALUES ($1, $2, $3, $4)`, [id, e.line_item, e.projected_value, period]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Forecast updated' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating forecast:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});
app.get('/api/forecasts/:budgetId/scenario/:scenarioId', async (req, res) => {
    try {
        const { budgetId, scenarioId } = req.params;
        const itemsRes = await pool.query(`SELECT id, department, category, planned_amt FROM budget_items WHERE budget_id = $1`, [budgetId]);
        const paramsRes = await pool.query(`SELECT param_key, param_value FROM forecast_entries WHERE forecast_id = $1`, [scenarioId]);
        const params = {};
        for (const r of paramsRes.rows) {
            params[r.param_key] = parseFloat(r.param_value);
        }
        const forecast = itemsRes.rows.map(item => {
            const factor = params[item.category] || params['__global'] || 1;
            return {
                ...item,
                forecast_amt: +(item.planned_amt * factor).toFixed(2)
            };
        });
        res.json(forecast);
    } catch (err) {
        console.error('Error fetching forecast data:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/budgets-with-items', async (req, res) => {
    const { name, department, category, date_from, date_to } = req.query;
    let sql = `
        SELECT
            b.id AS budget_id,
            b.name AS budget_name,
            b.period_start,
            b.period_end,
            b.created_by,
            b.created_at,
            bi.id AS item_id,
            COALESCE(bi.department, '-') AS department,
            COALESCE(bi.category, '-') AS category,
            COALESCE(bi.planned_amt::TEXT, '-') AS planned_amt,
            COALESCE(bi.actual_amt::TEXT,  '-') AS actual_amt
        FROM budgets b
        LEFT JOIN budget_items bi ON bi.budget_id = b.id
        WHERE 1=1
    `;
    const params = [];
    if (name) {
        params.push(`%${name}%`);
        sql += ` AND b.name ILIKE $${params.length}`;
    }
    if (department) {
        params.push(`%${department}%`);
        sql += ` AND bi.department ILIKE $${params.length}`;
    }
    if (category) {
        params.push(`%${category}%`);
        sql += ` AND bi.category ILIKE $${params.length}`;
    }
    if (date_from) {
        params.push(date_from);
        sql += ` AND b.period_start >= $${params.length}`;
    }
    if (date_to) {
        params.push(date_to);
        sql += ` AND b.period_end   <= $${params.length}`;
    }
    sql += ` ORDER BY b.created_at DESC, bi.id`;
    try {
        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching filtered budgets:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/budget-items/:id', async (req, res) => {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM budget_items WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
});
app.put('/api/budget-items/:id', async (req, res) => {
    const { id } = req.params;
    const { department, category, planned_amt, actual_amt } = req.body;
    await pool.query(`UPDATE budget_items SET department=$1, category=$2, planned_amt=$3, actual_amt=$4 WHERE id=$5`, [department, category, planned_amt, actual_amt, id]);
    res.json({ message: 'Updated' });
});
app.delete('/api/budget-items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM budget_items WHERE id = $1', [id]);
        res.json({ message: 'Budget item deleted' });
    } catch (err) {
        console.error('Error deleting budget item:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.delete('/api/budgets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM budgets WHERE id = $1', [id]);
        res.json({ message: 'Budget deleted' });
    } catch (err) {
        console.error('Error deleting budget:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/forecasts/:scenarioId/forecast-data', async (req, res) => {
    const { scenarioId } = req.params;
    try {
        const paramsRes = await pool.query('SELECT line_item, projected_value FROM forecast_entries WHERE forecast_id = $1', [scenarioId]);
        if (paramsRes.rows.length === 0) {
            return res.status(404).json({ error: 'No data found for this scenario' });
        }
        const params = {};
        for (const row of paramsRes.rows) {
            params[row.line_item] = parseFloat(row.projected_value);
        }
        const forecast = [];
        const itemsRes = await pool.query(`
            SELECT 
                bi.department, 
                bi.category, 
                bi.planned_amt, 
                b.name AS budget_name
            FROM budget_items bi
            JOIN budgets b ON bi.budget_id = b.id
        `);
        itemsRes.rows.forEach(item => {
            const factor = params[item.category] || 1;
            forecast.push({
                budget_name: item.budget_name,
                department: item.department,
                category: item.category,
                planned_amt: item.planned_amt,
                forecast_amt: (item.planned_amt * factor).toFixed(2)
            });
        });
        res.json(forecast);
    } catch (error) {
        console.error('Error generating forecast data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/forecast/budget-by-month', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                EXTRACT(MONTH FROM b.period_start) AS month,
                SUM(bi.planned_amt) AS planned_amount,
                SUM(bi.actual_amt) AS actual_amount
            FROM public.budgets b
            JOIN public.budget_items bi ON b.id = bi.budget_id
            GROUP BY month
            ORDER BY month;
        `);
        console.log('Data for budget by month:', result.rows);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching budget by month:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/forecast/budget-by-category', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                bi.category,
                SUM(bi.planned_amt) AS planned_amount,
                SUM(bi.actual_amt) AS actual_amount
            FROM public.budget_items bi
            JOIN public.budgets b ON bi.budget_id = b.id
            GROUP BY bi.category
            ORDER BY bi.category;
        `);
        console.log('Data for budget by category:', result.rows);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching budget by category:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/budget-performance', async (req, res) => {
    try {
        const { rows } = await pool.query(`
      SELECT 
        b.period_start::date AS month,
        COALESCE(SUM(bi.planned_amt),0) AS planned,
        COALESCE(SUM(bi.actual_amt),0)  AS actual
      FROM budgets b
      LEFT JOIN budget_items bi ON bi.budget_id = b.id
      GROUP BY b.period_start
      ORDER BY b.period_start
    `);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});
app.get('/api/budget-category', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT category, SUM(planned_amt) AS planned, SUM(actual_amt) AS actual FROM budget_items GROUP BY category ORDER BY category`);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});
app.get('/dashboard', (req, res) => {
    const { user_id, responsibilities } = req.query;
    const userResponsibilities = new Set(JSON.parse(decodeURIComponent(responsibilities || "[]")));
    let functionalities = '';
    if(userResponsibilities.has("Manage production processes")){
        functionalities += `
            <h1>Manage production processes</h1>
            <div id="edit-product-modal" style="display: none;">
                <h3>Edit Product</h3>
                <input type="hidden" id="edit-product-id">
                <label>Product Name:</label>
                <input type="text" id="edit-product-name"><br><br>
                <h4>Materials</h4>
                <div id="edit-materials-container"></div>
                <button class="btn" type="button" onclick="addMaterialField('', '', true)">Add Material</button><br><br>
                <button class="btn" onclick="updateProduct()">Save Changes</button>
                <button class="btn" onclick="document.getElementById('edit-product-modal').style.display='none'">Cancel</button>
            </div>
            <h3>Create Product</h3>
            <label>Product Name:</label>
            <input type="text" id="product-name"><br><br>
            <label>Materials</label>
            <div id="materials-container"></div>
            <button class="btn" type="button" onclick="addMaterialField()">➕ Add Material</button><br><br>
            <button class="btn" onclick="createProduct()">Create Product</button>
            <h3>Products</h3>
            <table class="table" border="1">
                <thead><tr><th>Name</th><th>Materials</th><th>Editor</th></tr></thead>
                <tbody id="products-table"></tbody>
            </table>
            <div id="edit-order-modal" style="display: none;">
                <h3>Edit Order</h3>
                <input type="hidden" id="edit-order-id">
                <label>Product:</label>
                <select id="edit-product-list"></select><br><br>
                <label>Quantity:</label>
                <input type="number" id="edit-quantity"><br><br>
                <label>Responsible User:</label>
                <select id="edit-user-list"></select><br><br>
                <label>Quality Control Responsible:</label>
                <select id="edit-control-user-list"></select><br><br>
                <button class="btn" onclick="updateOrder()">Save Changes</button>
                <button class="btn" onclick="document.getElementById('edit-order-modal').style.display='none'">Cancel</button>
            </div>
            <h3>Start Production</h3>
            <label>Product:</label>
            <select id="product-list"></select>
            <label>Quantity:</label>
            <input type="number" id="quantity">
            <label>Responsible User:</label>
            <select id="user-list"></select>
            <label>Quality Control Responsible:</label>
            <select id="control-user-list"></select>
            <button class="btn" onclick="startProduction()">Start Production</button>
            <h3>Production Orders</h3>
            <table class="table" border="1">
                <thead>
                    <tr><th>Product</th><th>Quantity</th><th>Status</th><th>Responsible</th><th>Control Responsible</th><th>Editor</th></tr>
                </thead>
                <tbody id="orders-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Control product quality")){
        functionalities += `
            <br><br><h1>Control product quality</h1><br><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Quantity</th>
                        <th>Responsible</th>
                        <th>Quality Score (0-10)</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="quality-control-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Monitor workers performance")) {
        functionalities += `
            <br><br><h1>Monitor workers performance</h1><br><br>
            <div>
                <label>Material:</label>
                <input type="text" id="perf-material-filter" oninput="loadPerformance()">
                <label>Date from:</label>
                <input type="date" id="perf-date-from" onchange="loadPerformance()">
                <label>to:</label>
                <input type="date" id="perf-date-to" onchange="loadPerformance()">
            </div><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Quantity</th>
                        <th>Materials</th>
                        <th>Responsible</th>
                        <th>Control Responsible</th>
                        <th>Quality Score</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Date of creation</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="workers-performance-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Perform production")) {
        functionalities += `
            <br><br><h1>Perform production</h1><br><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Quantity</th>
                        <th>Materials</th>
                        <th>Status</th>
                        <th>Notes</th>
                    </tr>
                </thead>
                <tbody id="user-orders-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Procure raw materials")) {
        functionalities += `
            <br><br><br><br><br><br><h1>Procure raw materials</h1><br><br>
            <div id="edit-supplier-modal" style="display: none;">
                <h3>Edit Supplier</h3>
                <input type="hidden" id="edit-supplier-id">
                <label>Supplier Name:</label>
                <input type="text" id="edit-supplier-name"><br><br>
                <label>Contact Info:</label>
                <textarea id="edit-supplier-contact"></textarea><br><br>
                <label>Quality Control Responsible:</label>
                <select id="edit-supplier-control-user-list"></select><br><br>
                <label>Materials Supplied:</label>
                <select id="edit-supplier-materials" multiple></select><br><br>
                <button class="btn" onclick="updateSupplier()">Save Changes</button>
                <button class="btn" onclick="document.getElementById('edit-supplier-modal').style.display='none'">Cancel</button>
            </div>
            <h3>Add New Supplier</h3>
            <label>Supplier Name:</label>
            <input type="text" id="supplier-name">
            <label>Contact Info:</label>
            <textarea id="supplier-contact"></textarea>
            <label>Quality Control Responsible:</label>
            <select id="supplier-control-user-list"></select>
            <label>Materials Supplied:</label>
            <select id="supplier-materials" multiple></select>
            <button class="btn" onclick="createSupplier()">Add Supplier</button>
            <h3>Suppliers List</h3>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Contact Info</th>
                        <th>Quality Control Responsible</th>
                        <th>Materials</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="suppliers-table"></tbody>
            </table>
            <h3>Create Purchase Request</h3>
            <label>Material Name:</label>
            <select id="purchase-material-list"></select><br><br>
            <label>Quantity:</label>
            <input type="number" id="purchase-quantity"><br><br>
            <label>Supplier:</label>
            <select id="purchase-supplier-list"></select><br><br>
            <label>Notes:</label>
            <textarea id="purchase-notes"></textarea><br><br>
            <button class="btn" onclick="createPurchaseRequest()">Create Request</button>
            <h3>Purchase Requests</h3>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Material</th>
                        <th>Quantity</th>
                        <th>Supplier</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="purchase-requests-table"></tbody>
            </table>
            <div id="edit-purchase-modal" style="display: none;">
                <h3>Edit Purchase Request</h3>
                <input type="hidden" id="edit-purchase-id">
                <label>Material Name:</label>
                <select id="edit-purchase-material-list"></select>
                <label>Quantity:</label>
                <input type="number" id="edit-purchase-quantity"><br><br>
                <label>Supplier:</label>
                <select id="edit-purchase-supplier-list"></select><br><br>
                <label>Notes:</label>
                <textarea id="edit-purchase-notes"></textarea><br><br>
                <button class="btn" onclick="updatePurchaseRequest()">Save Changes</button>
                <button class="btn" onclick="document.getElementById('edit-purchase-modal').style.display='none'">Cancel</button>
            </div>
            <h3>Purchase History</h3>
            <div id="purchase-history-filters">
                <label>Material:</label>
                <input type="text" id="ph-material-filter" oninput="loadPurchaseHistory()">
                <label>Date from:</label>
                <input type="date" id="ph-date-from" onchange="loadPurchaseHistory()">
                <label>to:</label>
                <input type="date" id="ph-date-to" onchange="loadPurchaseHistory()">
            </div><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Material</th>
                        <th>Quantity</th>
                        <th>Supplier</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Defect Report</th>
                        <th>Completed At</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="purchase-history-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Procure quality control")) {
        functionalities += `
            <br><br><h1>Procure quality control</h1><br><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Material</th>
                        <th>Quantity</th>
                        <th>Supplier</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Defect Reports</th>
                    </tr>
                </thead>
                <tbody id="active-purchase-requests-table"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Monitor warehouse inventory")) {
        functionalities += `
            <br><br><h1>Monitor warehouse inventory</h1><br><br>
            <h3>Current Warehouse Inventory</h3>
            <h4>Search Material</h4>
            <div id="warehouse-filters">
              <label>Material:</label>
              <input type="text" id="inventory-material-filter" oninput="loadWarehouseInventory()">
              <div id="warehouse-alerts" style="color: red; margin-top: 8px;"></div>
            </div><br>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Material Name</th>
                        <th>Quantity</th>
                    </tr>
                </thead>
                <tbody id="warehouse-inventory-table"></tbody>
            </table>
            <h3>Current Finished Goods Inventory</h3>
            <h4>Search Finished Goods</h4>
            <label for="finished-goods-search">Name:</label>
            <input type="text" id="finished-goods-search" oninput="filterFinishedGoods()"><br><br>
            <table class="table" border="1" id="finished-goods-inventory-table">
                <thead>
                    <tr><th>Product</th><th>Quantity</th></tr>
                </thead>
                <tbody id="finished-goods-inventory-table-body"></tbody>
            </table>
        `;
    }
    if(userResponsibilities.has("Recruit and hire employees")) {
        functionalities += `
            <br><br><h1>Recruit and hire employees</h1><br><br>
            <section id="add-role-section">
              <h3>Add New Role</h3>
              <label for="new-role-name">Role Name:</label>
              <input type="text" id="new-role-name"><br><br>
              <label>Responsibilities:</label><br><br>
              <div id="new-resp-container"></div>
              <button class="btn" type="button" onclick="createRole()">Add Role</button>
            </section>
            <h3>Roles Table</h3>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>Role Name</th>
                        <th>Responsibilities</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="role-table-body"></tbody>
            </table>
            <div id="edit-role-modal" style="display:none;">
                <h3>Edit Role</h3>
                <form id="edit-role-form">
                    <label for="edit-role-name">Role Name:</label>
                    <input type="text" id="edit-role-name" required><br><br>
                    <label>Responsibilities:</label>
                    <div id="edit-responsibilities-list"></div>
                    <input type="hidden" id="edit-role-id">
                    <button class="btn" type="button" onclick="saveRole()">Save</button>
                    <button class="btn" type="button" onclick="closeEditRoleModal()">Cancel</button>
                </form>
            </div>
            <h3>Add New Employee</h3>
            <form id="add-employee-form" onsubmit="addEmployee(event)">
                <label for="first_name">First Name:</label>
                <input type="text" id="first_name" name="first_name" required>
                <label for="last_name">Last Name:</label>
                <input type="text" id="last_name" name="last_name" required>
                <label for="role">Role:</label>
                <select id="role" name="role" required></select>
                <label for="email">Email:</label>
                <input type="email" id="email" name="email" required>
                <button class="btn" type="submit">Add Employee</button>
            </form>
            <h3>Search Employee</h3>
            <form id="search-form" oninput="updateTable(); return false;">
                <label for="first_name-search">First Name:</label>
                <input type="text" id="first_name-search" name="first_name-search" value="">
                <label for="last_name-search">Last Name:</label>
                <input type="text" id="last_name-search" name="last_name-search" value="">
                <label for="role-search">Role:</label>
                <select id="role-search" name="role-search"></select>
                <label for="email-search">Email:</label>
                <input type="text" id="email-search" name="email-search" value="">
            </form>
            <h3>Employee List</h3>
            <table class="table" border="1">
                <thead>
                    <tr>
                        <th>First Name</th>
                        <th>Last Name</th>
                        <th>Role</th>
                        <th>Email</th>
                        <th>Password</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="employee-table"></tbody>
            </table>
            <div id="edit-employee-modal" style="display: none;">
                <h3>Edit Employee</h3>
                <input type="hidden" id="edit-employee-id">
                <label>First Name:</label>
                <input type="text" id="edit-employee-first-name"><br><br>
                <label>Last Name:</label>
                <input type="text" id="edit-employee-last-name"><br><br>
                <label>Role:</label>
                <select id="edit-employee-role"></select><br><br>
                <label>Email:</label>
                <input type="email" id="edit-employee-email"><br><br>
                <label>Password:</label>
                <input type="text" id="edit-employee-password"><br>
                <div id="password-error" style="color: red; display: none;">Password must be between 16 and 35 characters long.</div><br>
                <button class="btn" onclick="updateEmployee()">Save Changes</button>
                <button class="btn" onclick="document.getElementById('edit-employee-modal').style.display='none'">Cancel</button>
            </div>
        `;
    }
    if(userResponsibilities.has("Analyze market and competitors")) {
        functionalities += `
            <br><br><h1>Analyze market and competitors</h1><br><br>
            <section id="competitors-admin">
                <h3>Add Competitor</h3>
                <form id="add-competitor-form">
                    <label>Name:</label>
                    <input type="text" id="new-competitor-name" required>
                    <label>Website:</label>
                    <input type="url" id="new-competitor-website">
                    <label>Industry:</label>
                    <input type="text" id="new-competitor-industry">
                    <label>Notes:</label>
                    <textarea id="new-competitor-notes"></textarea>
                    <button class="btn" type="submit">Add Competitor</button>
                </form>
                <h3>Search Competitor</h3>
                <div>
                    <label>Name:</label>
                    <input type="text" id="competitor-search" oninput="filterCompetitors()">
                    <label>Industry:</label>
                    <select id="competitor-industry-filter" onchange="filterCompetitors()">
                        <option value="">All industries</option>
                    </select>
                </div><br>
                <table class="table" border="1">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Website</th>
                            <th>Industry</th>
                            <th>Notes</th>
                            <th>Rating</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody id="competitors-table-body"></tbody>
                </table>
                <div id="edit-competitor-modal" style="display:none;">
                    <h4>Edit Competitor</h4>
                    <form id="edit-competitor-form">
                        <input type="hidden" id="edit-competitor-id">
                        <label>Name:</label><br>
                        <input type="text" id="edit-competitor-name" required><br><br>
                        <label>Website:</label><br>
                        <input type="url" id="edit-competitor-website"><br><br>
                        <label>Industry:</label><br>
                        <input type="text" id="edit-competitor-industry"><br><br>
                        <label>Notes:</label><br>
                        <textarea id="edit-competitor-notes"></textarea><br><br>
                        <button class="btn" type="button" onclick="saveCompetitor()">Save</button>
                        <button class="btn" type="button" onclick="closeEditCompetitorModal()">Cancel</button>
                    </form>
                </div>
            </section>
            <script>
                let allCompetitors = [];
                function renderStars(rating, id) {
                    let html = '';
                    for (let i = 1; i <= 5; i++) {
                        html += \`<span onclick="updateCompetitorRating(\${id}, \${i})" style="cursor:pointer;">\${i <= rating ? '★' : '☆'}</span>\`;
                    }
                    return html;
                }
                document.addEventListener('DOMContentLoaded', () => {
                    loadCompetitorsTable();
                    populateIndustryFilter();
                    document.getElementById('add-competitor-form')
                        .addEventListener('submit', e => { e.preventDefault(); createCompetitor(); });
                });
                async function loadCompetitorsTable() {
                    const res = await fetch('/api/competitors');
                    allCompetitors = await res.json();
                    renderCompetitors(allCompetitors);
                }
                function renderCompetitors(list) {
                    const tbody = document.getElementById('competitors-table-body');
                    tbody.innerHTML = list.map(c => \`
                        <tr>
                            <td>\${c.name}</td>
                            <td><a href="\${c.website || '#'}" target="_blank">\${c.website || '—'}</a></td>
                            <td>\${c.industry || '—'}</td>
                            <td>\${c.notes || ''}</td>
                            <td>\${renderStars(c.rating, c.id)}</td>
                            <td>
                                <button class="btn" onclick="openEditCompetitorModal(\${c.id})">Edit</button>
                                <button class="btn" onclick="deleteCompetitor(\${c.id})">Delete</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                async function updateCompetitorRating(id, rating) {
                    try {
                        const res = await fetch(\`/api/competitors/\${id}/rating\`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ rating })
                        });
                        if (!res.ok) {
                            const data = await res.json();
                            return alert(data.error || 'Failed to update rating.');
                        }
                        const comp = allCompetitors.find(c => c.id === id);
                        if (comp) comp.rating = rating;
                        renderCompetitors(allCompetitors);
                    } catch (err) {
                        console.error('Error updating rating:', err);
                        alert('Unexpected error, see console.');
                    }
                }
                function filterCompetitors() {
                    const nameFilter = document.getElementById('competitor-search').value.toLowerCase();
                    const industryFilter = document.getElementById('competitor-industry-filter').value;
                    const filtered = allCompetitors.filter(c => {
                        return c.name.toLowerCase().includes(nameFilter)
                            && (!industryFilter || c.industry === industryFilter);
                    });
                    renderCompetitors(filtered);
                }
                async function createCompetitor() {
                    const name = document.getElementById('new-competitor-name').value.trim();
                    const website = document.getElementById('new-competitor-website').value.trim();
                    const industry = document.getElementById('new-competitor-industry').value.trim();
                    if (!name) {
                        return alert('Name is required.');
                    }
                    const res = await fetch('/api/competitors', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ name, website, industry })
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        return alert(data.error || 'Failed to add competitor.');
                    }
                    document.getElementById('add-competitor-form').reset();
                    loadCompetitorsTable();
                    location.reload();
                }
                async function openEditCompetitorModal(id) {
                    const res = await fetch('/api/competitors');
                    const rows = await res.json();
                    const comp = rows.find(c => c.id === id);
                    if (!comp) return alert('Not found.');
                    document.getElementById('edit-competitor-id').value = comp.id;
                    document.getElementById('edit-competitor-name').value = comp.name;
                    document.getElementById('edit-competitor-website').value = comp.website || '';
                    document.getElementById('edit-competitor-industry').value = comp.industry || '';
                    document.getElementById('edit-competitor-modal').style.display = 'block';
                }
                function closeEditCompetitorModal() {
                    document.getElementById('edit-competitor-modal').style.display = 'none';
                }
                async function saveCompetitor() {
                    const id = document.getElementById('edit-competitor-id').value;
                    const name = document.getElementById('edit-competitor-name').value.trim();
                    const website = document.getElementById('edit-competitor-website').value.trim();
                    const industry = document.getElementById('edit-competitor-industry').value.trim();
                    if (!name) {
                        return alert('Name is required.');
                    }
                    const res = await fetch(\`/api/competitors/\${id}\`, {
                        method: 'PUT',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ name, website, industry })
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        return alert(data.error || 'Failed to update competitor.');
                    }
                    closeEditCompetitorModal();
                    loadCompetitorsTable();
                    location.reload();
                }
                async function deleteCompetitor(id) {
                    if (!confirm('Delete this competitor?')) return;
                    const res = await fetch(\`/api/competitors/\${id}\`, { method: 'DELETE' });
                    const data = await res.json();
                    if (!res.ok) {
                        return alert(data.error || 'Failed to delete competitor.');
                    }
                    loadCompetitorsTable();
                }
                async function populateIndustryFilter() {
                    const industries = [...new Set((await fetch('/api/competitors').then(r => r.json()))
                        .map(c => c.industry).filter(i => i))];
                    const select = document.getElementById('competitor-industry-filter');
                    industries.forEach(ind => {
                        const opt = document.createElement('option');
                        opt.value = ind; opt.textContent = ind;
                        select.appendChild(opt);
                    });
                }
            </script>
        `;
    }
    if (userResponsibilities.has("Develop marketing campaigns")) {
        functionalities += `
            <br><br><h1>Develop marketing campaigns</h1><br><br>
            <h3>Add Campaign</h3>
            <form id="campaign-form">
                <label>Name:</label>
                <input type="text" id="campaign-name" required>
                <label>Channel:</label>
                <select id="campaign-channel">
                    <option value="email">Email</option>
                    <option value="social-media">Social Media</option>
                    <option value="PPC">PPC</option>
                </select>
                <label>Audience Segment:</label>
                <input type="text" id="campaign-audience" required>
                <label>Budget:</label>
                <input type="number" id="campaign-budget" required><br><br>
                <label>Start Date:</label>
                <input type="date" id="campaign-start-date" required>
                <label>End Date:</label>
                <input type="date" id="campaign-end-date" required>
                <label>Status:</label>
                <select id="campaign-status">
                    <option value="Draft">Draft</option>
                    <option value="Running">Running</option>
                    <option value="Completed">Completed</option>
                </select>
                <label>Notes:</label>
                <textarea id="campaign-notes"></textarea>
                <button class="btn" type="submit">Create Campaign</button>
            </form>
            <h3>Existing Campaigns</h3>
            <table class="table" border="1" id="campaigns-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Channel</th>
                        <th>Audience</th>
                        <th>Budget</th>
                        <th>Start Date</th>
                        <th>End Date</th>
                        <th>Status</th>
                        <th>Notes</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="campaigns-table-body"></tbody>
            </table>
            <div id="edit-campaign-modal" class="modal">
                <div class="modal-content">
                    <h3>Edit Campaign</h3>
                    <form id="edit-campaign-form">
                        <input type="hidden" id="edit-campaign-id">
                        <label>Name:</label><br>
                        <input type="text" id="edit-campaign-name" required><br><br>
                        <label>Channel:</label><br>
                        <select id="edit-campaign-channel">
                            <option value="email">Email</option>
                            <option value="social-media">Social Media</option>
                            <option value="PPC">PPC</option>
                        </select><br><br>
                        <label>Audience Segment:</label><br>
                        <input type="text" id="edit-campaign-audience"><br><br>
                        <label>Budget:</label><br>
                        <input type="number" id="edit-campaign-budget" step="0.01" min="0"><br><br>
                        <label>Start Date:</label><br>
                        <input type="date" id="edit-campaign-start-date"><br><br>
                        <label>End Date:</label><br>
                        <input type="date" id="edit-campaign-end-date"><br><br>
                        <label>Status:</label><br>
                        <select id="edit-campaign-status">
                            <option value="Draft">Draft</option>
                            <option value="Running">Running</option>
                            <option value="Completed">Completed</option>
                        </select><br><br>
                        <label>Notes:</label><br>
                        <textarea id="edit-campaign-notes"></textarea><br><br>
                        <button class="btn" type="submit">Save Changes</button>
                        <button class="btn" type="button" onclick="closeEditModal()">Cancel</button>
                    </form>
                </div>
            </div>
            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    loadCampaigns();
                    const form = document.getElementById('campaign-form');
                    form.addEventListener('submit', async e => {
                        e.preventDefault();
                        const start = new Date(document.getElementById('campaign-start-date').value);
                        const end = new Date(document.getElementById('campaign-end-date').value);
                        if (start > end) {
                            return alert('Start date cannot be later than end date.');
                        }
                        const name = document.getElementById('campaign-name').value.trim();
                        const existing = Array.from(document.querySelectorAll('#campaigns-table-body tr td:first-child')).map(td => td.textContent);
                        if (existing.includes(name)) {
                            return alert('Campaign name must be unique.');
                        }
                        const data = {
                            name,
                            channel: document.getElementById('campaign-channel').value,
                            audience_segment: document.getElementById('campaign-audience').value.trim(),
                            budget: parseFloat(document.getElementById('campaign-budget').value),
                            start_date: document.getElementById('campaign-start-date').value,
                            end_date: document.getElementById('campaign-end-date').value,
                            status: document.getElementById('campaign-status').value,
                            notes: document.getElementById('campaign-notes').value.trim()
                        };
                        await createCampaign(data);
                        form.reset();
                    });
                    const editForm = document.getElementById('edit-campaign-form');
                    editForm.addEventListener('submit', async e => {
                        e.preventDefault();
                        const id = document.getElementById('edit-campaign-id').value;
                        const start = new Date(document.getElementById('edit-campaign-start-date').value);
                        const end = new Date(document.getElementById('edit-campaign-end-date').value);
                        if (start > end) {
                            return alert('Start date cannot be later than end date.');
                        }
                        const name = document.getElementById('edit-campaign-name').value.trim();
                        const existing = Array.from(document.querySelectorAll('#campaigns-table-body tr')).map(tr => tr.children[0].textContent).filter(n => n !== document.getElementById('edit-campaign-name').dataset.original);
                        if (existing.includes(name)) {
                            return alert('Campaign name must be unique.');
                        }
                        const data = {
                            name,
                            channel: document.getElementById('edit-campaign-channel').value,
                            audience_segment: document.getElementById('edit-campaign-audience').value.trim(),
                            budget: parseFloat(document.getElementById('edit-campaign-budget').value),
                            start_date: document.getElementById('edit-campaign-start-date').value,
                            end_date: document.getElementById('edit-campaign-end-date').value,
                            status: document.getElementById('edit-campaign-status').value,
                            notes: document.getElementById('edit-campaign-notes').value.trim()
                        };
                        await updateCampaign(id, data);
                    });
                });
                async function loadCampaigns() {
                    const res = await fetch('/api/campaigns');
                    const campaigns = await res.json();
                    renderCampaigns(campaigns);
                }
                function renderCampaigns(campaigns) {
                    const tbody = document.getElementById('campaigns-table-body');
                    tbody.innerHTML = campaigns.map(c => \`
                        <tr>
                            <td>\${c.name}</td>
                            <td>\${c.channel}</td>
                            <td>\${c.audience_segment}</td>
                            <td>\${c.budget}</td>
                            <td>\${new Date(c.start_date).toLocaleDateString()}</td>
                            <td>\${new Date(c.end_date).toLocaleDateString()}</td>
                            <td>\${c.status}</td>
                            <td>\${c.notes || ''}</td>
                            <td>
                                <button class="btn" onclick="editCampaign(\${c.id})">Edit</button>
                                <button class="btn" onclick="deleteCampaign(\${c.id})">Delete</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                async function createCampaign(data) {
                    const res = await fetch('/api/campaigns', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify(data)
                    });
                    if (res.status === 400) {
                        const err = await res.json();
                        return alert(err.error);
                    }
                    if (res.ok) loadCampaigns();
                }
                async function editCampaign(id) {
                    const res = await fetch(\`/api/campaigns/\${id}\`);
                    const c = await res.json();
                    const start = new Date(c.start_date);
                    const end = new Date(c.end_date);
                    const pad = n => String(n).padStart(2, '0');
                    const localStart = \`\${start.getFullYear()}-\${pad(start.getMonth() + 1)}-\${pad(start.getDate())}\`;
                    const localEnd = \`\${end.getFullYear()}-\${pad(end.getMonth() + 1)}-\${pad(end.getDate())}\`;
                    document.getElementById('edit-campaign-id').value = c.id;
                    const nameInput = document.getElementById('edit-campaign-name');
                    nameInput.value = c.name;
                    nameInput.dataset.original = c.name;
                    document.getElementById('edit-campaign-channel').value = c.channel;
                    document.getElementById('edit-campaign-audience').value = c.audience_segment;
                    document.getElementById('edit-campaign-budget').value = c.budget;
                    document.getElementById('edit-campaign-start-date').value = localStart;
                    document.getElementById('edit-campaign-end-date').value = localEnd;
                    document.getElementById('edit-campaign-status').value = c.status;
                    document.getElementById('edit-campaign-notes').value = c.notes || '';
                    document.getElementById('edit-campaign-modal').style.display = 'block';
                }
                async function updateCampaign(id, data) {
                    if (new Date(data.start_date) > new Date(data.end_date)) {
                        return alert('Start date cannot be later than end date.');
                    }
                    const res = await fetch(\`/api/campaigns/\${id}\`, {
                        method: 'PUT',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify(data)
                    });
                    if (res.status === 400) {
                        const err = await res.json();
                        return alert(err.error);
                    }
                    if (res.ok) {
                        loadCampaigns();
                        closeEditModal();
                    }
                }
                function closeEditModal() {
                    document.getElementById('edit-campaign-modal').style.display = 'none';
                }
                async function deleteCampaign(id) {
                    const res = await fetch(\`/api/campaigns/\${id}\`, { method: 'DELETE' });
                    if (res.ok) loadCampaigns();
                }
            </script>
        `;
    }
    if (userResponsibilities.has("Engage with customers and negotiate deals")) {
        functionalities += `
            <br><br><h1>Engage with customers and negotiate deals</h1><br><br>
            <section id="crm">
                <h3>Add Client</h3>
                <form id="add-client-form">
                    <label>Name:</label>
                    <input type="text" id="client-name" required>
                    <label>Company:</label>
                    <input type="text" id="client-company">
                    <label>Email:</label>
                    <input type="email" id="client-email">
                    <label>Phone:</label>
                    <input type="tel" id="client-phone">
                    <label>Segment:</label>
                    <input type="text" id="client-segment">
                    <button class="btn" type="submit">Add Client</button>
                </form>
                <h3>Search Clients</h3>
                <label>Name:</label>
                <input type="text" id="client-search" oninput="filterClients()">
                <h3>Clients</h3>
                <table class="table" border="1" id="clients-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Company</th>
                            <th>Email</th>
                            <th>Phone</th>
                            <th>Segment</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody id="clients-table-body"></tbody>
                </table>
            </section>
            <div id="edit-client-modal" class="modal" style="display:none;">
                <div class="modal-content">
                    <h3>Edit Client</h3>
                    <form id="edit-client-form">
                        <input type="hidden" id="edit-client-id">
                        <label>Name:</label>
                        <input type="text" id="edit-client-name" required>
                        <label>Company:</label>
                        <input type="text" id="edit-client-company">
                        <label>Email:</label>
                        <input type="email" id="edit-client-email">
                        <label>Phone:</label>
                        <input type="tel" id="edit-client-phone">
                        <label>Segment:</label>
                        <input type="text" id="edit-client-segment">
                        <button class="btn" type="submit">Save Changes</button>
                        <button class="btn" type="button" onclick="closeEditClientModal()">Cancel</button>
                    </form>
                </div>
            </div>
            <section id="sales">
                <h3>Create Sales Order</h3>
                <form id="add-sales-form">
                    <label>Product:</label>
                    <select id="sales-product-select" required></select>
                    <label>Quantity:</label>
                    <input type="number" id="sales-quantity" min="1" required>
                    <label>Unit Price:</label>
                    <input type="number" id="sales-price" step="0.01" min="0" required>
                    <label>Customer:</label>
                    <select id="sales-customer-select" required></select>
                    <label>Responsible:</label>
                    <select id="sales-responsible-select" required></select>
                    <button class="btn" type="submit">Add Order</button>
                </form>
                <h3>Search Orders</h3>
                <label>Product:</label>
                <input type="text" id="sales-search-product" oninput="filterSales()">
                <label>Status:</label>
                <select id="sales-status-filter" onchange="filterSales()">
                    <option value="">All</option>
                    <option value="New">New</option>
                    <option value="Processing">Processing</option>
                    <option value="Shipped">Shipped</option>
                    <option value="Delivered">Delivered</option>
                    <option value="Cancelled">Cancelled</option>
                </select>
                <h3>Sales Orders</h3>
                <table class="table" border="1" id="sales-table">
                    <thead>
                        <tr>
                            <th>Product</th>
                            <th>Quantity</th>
                            <th>Unit Price</th>
                            <th>Total Price</th>
                            <th>Customer</th>
                            <th>Status</th>
                            <th>Responsible</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody id="sales-table-body"></tbody>
                </table>
                <div id="edit-sales-modal" style="display:none;">
                    <div>
                        <h3>Edit Sales Order</h3>
                        <form id="edit-sales-form">
                            <input type="hidden" id="edit-sales-id">
                            <label>Product:</label>
                            <select id="edit-sales-product-select" required></select><br><br>
                            <label>Quantity:</label>
                            <input type="number" id="edit-sales-quantity" min="1" required><br><br>
                            <label>Unit Price:</label>
                            <input type="number" id="edit-sales-price" step="0.01" min="0" required><br><br>
                            <label>Status:</label>
                            <select id="edit-sales-status" required>
                                <option value="New">New</option>
                                <option value="Processing">Processing</option>
                                <option value="Shipped">Shipped</option>
                                <option value="Delivered">Delivered</option>
                                <option value="Cancelled">Cancelled</option>
                            </select><br><br>
                            <label>Customer:</label>
                            <select id="edit-sales-customer-select" required></select><br><br>
                            <label>Responsible:</label>
                            <select id="edit-sales-responsible-select" required></select><br><br>
                            <button class="btn" type="submit">Save</button>
                            <button class="btn" type="button" onclick="closeEditSalesModal()">Cancel</button>
                        </form>
                    </div>
                </div>
                <h3>Completed Sales History</h3>
                <label>Product:</label>
                <input type="text" id="history-search" oninput="filterHistory()"><br><br>
                <table class="table" border="1" id="history-table">
                    <thead>
                        <tr>
                            <th>Product</th>
                            <th>Quantity</th>
                            <th>Unit Price</th>
                            <th>Total</th>
                            <th>Customer</th>
                            <th>Responsible</th>
                            <th>Delivered At</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody id="history-body"></tbody>
                </table>
            </section>
            <script>
                async function loadCompletedSales() {
                    const res = await fetch('/api/completed-sales');
                    const list = await res.json();
                    const tbody = document.getElementById('history-body');
                    tbody.innerHTML = list.map(o => \`
                        <tr>
                            <td>\${o.product_name}</td>
                            <td>\${o.quantity}</td>
                            <td>\${parseFloat(o.unit_price).toFixed(2)}</td>
                            <td>\${parseFloat(o.total_price).toFixed(2)}</td>
                            <td>\${o.customer_name}</td>
                            <td>\${o.responsible_name}</td>
                            <td>\${new Date(o.completed_at).toLocaleString()}</td>
                            <td>
                                <button class="btn" onclick="deleteCompletedSale(\${o.id})">Delete</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                function filterHistory() {
                    const q = document.getElementById('history-search').value.toLowerCase();
                    document.querySelectorAll('#history-body tr').forEach(tr => {
                        const prod = tr.children[0].textContent.toLowerCase();
                        tr.style.display = prod.includes(q) ? '' : 'none';
                    });
                }
                async function deleteCompletedSale(id) {
                    if (!confirm('Delete this sale from history?')) return;
                    const res = await fetch(\`/api/completed-sales/\${id}\`, { method: 'DELETE' });
                    if (res.ok) {
                        loadCompletedSales();
                    } else {
                        const err = await res.json();
                        alert(err.error || 'Can not delete sale.');
                    }
                }
                async function populateEditSalesDropdowns() {
                    const [prods, customers, reps] = await Promise.all([
                        fetch('/api/products').then(r => r.json()),
                        fetch('/api/clients').then(r => r.json()),
                        fetch('/api/users/responsibility/Engage%20with%20customers%20and%20negotiate%20deals').then(r => r.json())
                    ]);
                    document.getElementById('edit-sales-product-select').innerHTML = prods.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
                    document.getElementById('edit-sales-customer-select').innerHTML = customers.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
                    document.getElementById('edit-sales-responsible-select').innerHTML = reps.map(u => \`<option value="\${u.id}">\${u.first_name} \${u.last_name}</option>\`).join('');
                }
                async function openEditSalesModal(id) {
                    await populateEditSalesDropdowns();
                    const res = await fetch(\`/api/sales-orders/\${id}\`);
                    const o = await res.json();
                    document.getElementById('edit-sales-id').value = o.id;
                    document.getElementById('edit-sales-product-select').value = o.product_id;
                    document.getElementById('edit-sales-quantity').value = o.quantity;
                    document.getElementById('edit-sales-price').value = o.unit_price;
                    document.getElementById('edit-sales-status').value = o.status;
                    document.getElementById('edit-sales-customer-select').value = o.customer_id;
                    document.getElementById('edit-sales-responsible-select').value = o.responsible_id;
                    document.getElementById('edit-sales-modal').style.display = 'block';
                }
                function closeEditSalesModal() {
                    document.getElementById('edit-sales-modal').style.display = 'none';
                }
                document.getElementById('edit-sales-form').addEventListener('submit', async e => {
                    e.preventDefault();
                    const id = document.getElementById('edit-sales-id').value;
                    const data = {
                        product_id : parseInt(document.getElementById('edit-sales-product-select').value),
                        quantity : parseInt(document.getElementById('edit-sales-quantity').value),
                        unit_price : parseFloat(document.getElementById('edit-sales-price').value),
                        status : document.getElementById('edit-sales-status').value,
                        customer_id : parseInt(document.getElementById('edit-sales-customer-select').value),
                        responsible_id : parseInt(document.getElementById('edit-sales-responsible-select').value),
                    };
                    const res = await fetch(\`/api/sales-orders/\${id}\`, {
                        method : 'PUT',
                        headers: {'Content-Type':'application/json'},
                        body   : JSON.stringify(data)
                    });
                    if (res.ok) {
                        loadSalesDeals();
                        closeEditSalesModal();
                    } else {
                        const err = await res.json();
                        alert(err.error || 'Failed to update order');
                    }
                });
                function openEditClientModal(id) {
                    fetch(\`/api/clients/\${id}\`).then(r => r.json()).then(c => {
                        document.getElementById('edit-client-id').value = c.id;
                        document.getElementById('edit-client-name').value = c.name;
                        document.getElementById('edit-client-company').value = c.company || '';
                        document.getElementById('edit-client-email').value = c.email   || '';
                        document.getElementById('edit-client-phone').value = c.phone   || '';
                        document.getElementById('edit-client-segment').value = c.segment || '';
                        document.getElementById('edit-client-modal').style.display = 'block';
                    });
                }
                async function handleEditClient(e) {
                    e.preventDefault();
                    const id = document.getElementById('edit-client-id').value;
                    const data = {
                        name: document.getElementById('edit-client-name').value.trim(),
                        company: document.getElementById('edit-client-company').value.trim(),
                        email: document.getElementById('edit-client-email').value.trim(),
                        phone: document.getElementById('edit-client-phone').value.trim(),
                        segment: document.getElementById('edit-client-segment').value.trim()
                    };
                    const res = await fetch(\`/api/clients/\${id}\`, {
                        method: 'PUT',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        closeEditClientModal();
                        loadClients();
                    } else {
                        const err = await res.json();
                        alert(err.error);
                    }
                }
                function closeEditClientModal() {
                    document.getElementById('edit-client-modal').style.display = 'none';
                }
                document.addEventListener('DOMContentLoaded', () => {
                    loadClients();
                    loadProductsDeals();
                    loadUsersDeals();
                    loadSalesDeals();
                    loadCompletedSales();
                    document.getElementById('add-client-form').addEventListener('submit', handleAddClient);
                    document.getElementById('edit-client-form').addEventListener('submit', handleEditClient);
                    document.getElementById('add-sales-form').addEventListener('submit', handleAddSales);
                });
                async function loadClients() {
                    const res = await fetch('/api/clients');
                    const list = await res.json();
                    renderClients(list);
                    const custSelect = document.getElementById('sales-customer-select');
                    custSelect.innerHTML = list.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
                }
                function renderClients(list) {
                    const tbody = document.getElementById('clients-table-body');
                    tbody.innerHTML = list.map(c => \`
                        <tr>
                            <td>\${c.name}</td>
                            <td>\${c.company || ''}</td>
                            <td>\${c.email || ''}</td>
                            <td>\${c.phone || ''}</td>
                            <td>\${c.segment || ''}</td>
                            <td>
                                <button class="btn" onclick="openEditClientModal(\${c.id})">Edit</button>
                                <button class="btn" onclick="deleteClient(\${c.id})">Delete</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                async function handleAddClient(e) {
                    e.preventDefault();
                    const data = {
                        name: document.getElementById('client-name').value.trim(),
                        company: document.getElementById('client-company').value.trim(),
                        email: document.getElementById('client-email').value.trim(),
                        phone: document.getElementById('client-phone').value.trim(),
                        segment: document.getElementById('client-segment').value.trim()
                    };
                    const res = await fetch('/api/clients', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        e.target.reset();
                        loadClients();
                    } else {
                        const err = await res.json();
                        alert(err.error);
                    }
                }
                async function deleteClient(id) {
                    if (!confirm('Delete this client?')) return;
                    const res = await fetch(\`/api/clients/\${id}\`, { method: 'DELETE' });
                    if (res.ok) loadClients();
                }
                function filterClients() {
                    const q = document.getElementById('client-search').value.toLowerCase();
                    document.querySelectorAll('#clients-table-body tr').forEach(tr => {
                        const name = tr.children[0].textContent.toLowerCase();
                        tr.style.display = name.includes(q) ? '' : 'none';
                    });
                }
                async function loadProductsDeals() {
                    const res = await fetch('/api/products');
                    const list = await res.json();
                    const sel = document.getElementById('sales-product-select');
                    sel.innerHTML = list.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
                }
                async function loadUsersDeals() {
                    const res = await fetch('/api/users-deals');
                    const list = await res.json();
                    const sel  = document.getElementById('sales-responsible-select');
                    sel.innerHTML = list.map(u => \`<option value="\${u.id}">\${u.first_name} \${u.last_name}</option>\`).join('');
                }
                async function loadSalesDeals() {
                    const res = await fetch('/api/sales-orders');
                    const list = await res.json();
                    renderSales(list);
                }
                function renderSales(list) {
                    const tbody = document.getElementById('sales-table-body');
                    tbody.innerHTML = list.map(o => {
                        const total = (o.quantity * o.unit_price).toFixed(2);
                        return \`
                            <tr>
                                <td>\${o.product_name}</td>
                                <td>\${o.quantity}</td>
                                <td>\${o.unit_price}</td>
                                <td>\${total}</td>
                                <td>\${o.customer_name}</td>
                                <td>\${o.status}</td>
                                <td>\${o.responsible_name}</td>
                                <td>
                                    <button class="btn" onclick="openEditSalesModal(\${o.id})">Edit</button>
                                    <button class="btn" onclick="deleteSales(\${o.id})">Delete</button>
                                </td>
                            </tr>
                        \`;
                    }).join('');
                }
                async function handleAddSales(e) {
                    e.preventDefault();
                    const data = {
                        product_id: parseInt(document.getElementById('sales-product-select').value),
                        quantity: parseInt(document.getElementById('sales-quantity').value),
                        unit_price: parseFloat(document.getElementById('sales-price').value),
                        customer_id: parseInt(document.getElementById('sales-customer-select').value),
                        status: 'New',
                        responsible_id: parseInt(document.getElementById('sales-responsible-select').value)
                    };
                    const res = await fetch('/api/sales-orders', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        e.target.reset();
                        loadSalesDeals();
                    } else {
                        const err = await res.json();
                        alert(err.error);
                    }
                }
                async function deleteSales(id) {
                    if (!confirm('Delete this order?')) return;
                    const res = await fetch(\`/api/sales-orders/\${id}\`, { method: 'DELETE' });
                    if (res.ok) loadSalesDeals();
                }
                function filterSales() {
                    const prodQ = document.getElementById('sales-search-product').value.toLowerCase();
                    const statusF = document.getElementById('sales-status-filter').value;
                    document.querySelectorAll('#sales-table-body tr').forEach(tr => {
                        const prod   = tr.children[0].textContent.toLowerCase();
                        const status = tr.children[5].textContent;
                        const okProd = prod.includes(prodQ);
                        const okStatus = !statusF || status === statusF;
                        tr.style.display = (okProd && okStatus) ? '' : 'none';
                    });
                }
            </script>
        `;
    }
    if (userResponsibilities.has("Calculate product cost")) {
        functionalities += `
            <br><br><h1>Calculate product cost</h1>
            <label>Product:</label>
            <select id="cost-product-select"></select>
            <button class="btn" onclick="calculateCost()">Compute Cost</button>
            <table class="table" border="1" id="cost-table">
                <thead>
                    <tr>
                        <th>Material</th>
                        <th>Quantity per Unit</th>
                        <th>Unit Cost</th>
                        <th>Cost</th>
                    </tr>
                </thead>
                <tbody></tbody>
                <tfoot>
                    <tr>
                        <td colspan="3"><strong>Total:</strong></td>
                        <td id="cost-total"></td>
                    </tr>
                </tfoot>
            </table>
            <h3>Materials and their cost</h3>
            <table class="table" border="1" id="material-costs-table">
                <thead>
                    <tr>
                        <th>Material Name</th>
                        <th>Cost per Unit</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="material-costs-body"></tbody>
            </table>
            <div id="edit-material-modal" style="display:none;">
                <h4>Edit Material Cost</h4>
                <input type="hidden" id="edit-material-name">
                <label>Cost per Unit:</label><br>
                <input type="number" id="edit-material-cost" step="0.01" min="0">
                <button class="btn" onclick="saveMaterialCost()">Save</button>
                <button class="btn" onclick="closeMaterialModal()">Cancel</button>
            </div>
            <script>
                async function loadMaterialCosts() {
                    const res = await fetch('/api/material-costs');
                    const list = await res.json();
                    const tbody = document.getElementById('material-costs-body');
                    tbody.innerHTML = list.map(m => \`
                        <tr>
                            <td>\${m.material_name}</td>
                            <td>\${m.cost_per_unit}</td>
                            <td>
                                <button class="btn" onclick="openMaterialModal('\${m.material_name}', \${m.cost_per_unit})">Edit</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                function openMaterialModal(name, cost) {
                    document.getElementById('edit-material-name').value = name;
                    document.getElementById('edit-material-cost').value = cost;
                    document.getElementById('edit-material-modal').style.display = 'block';
                }
                function closeMaterialModal() {
                    document.getElementById('edit-material-modal').style.display = 'none';
                }
                async function saveMaterialCost() {
                    const name = document.getElementById('edit-material-name').value;
                    const cost = parseFloat(document.getElementById('edit-material-cost').value);
                    const res = await fetch(\`/api/material-costs/\${encodeURIComponent(name)}\`, {
                        method: 'PUT',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ cost_per_unit: cost })
                    });
                    if (!res.ok) {
                        alert((await res.json()).error);
                    } else {
                        closeMaterialModal();
                        loadMaterialCosts();
                    }
                }
                async function loadCostProducts() {
                    const res = await fetch('/api/products');
                    const list = await res.json();
                    document.getElementById('cost-product-select').innerHTML =
                        list.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
                }
                async function calculateCost() {
                    const pid = document.getElementById('cost-product-select').value;
                    const res = await fetch(\`/api/product-cost/\${pid}\`);
                    if (!res.ok) return alert((await res.json()).error);
                    const { breakdown, totalCost } = await res.json();
                    const tbody = document.querySelector('#cost-table tbody');
                    tbody.innerHTML = breakdown.map(b => \`
                        <tr>
                            <td>\${b.material}</td>
                            <td>\${b.qtyPerUnit}</td>
                            <td>\${b.costPerUnit}</td>
                            <td>\${parseFloat(b.cost).toFixed(2)}</td>
                        </tr>
                    \`).join('');
                    document.getElementById('cost-total').textContent = totalCost.toFixed(2);
                }
                document.addEventListener('DOMContentLoaded', () => {
                    loadCostProducts();
                    loadMaterialCosts();
                });
            </script>
        `;
    }
    if(userResponsibilities.has("Manage company budget")) {
        functionalities += `
            <br><br><h1>Manage company budget</h1><br><br>
            <section id="budgeting">
                <h3>Multilevel Budgeting</h3>
                <form id="budget-form">
                    <label for="budget-name">Budget Name:</label>
                    <input type="text" id="budget-name" required>
                    <label for="budget-start">Period Start:</label>
                    <input type="date" id="budget-start" required>
                    <label for="budget-end">Period End:</label>
                    <input type="date" id="budget-end" required>
                    <label for="department">Department:</label>
                    <select id="department" name="department" required>
                        <option value="" disabled selected>Select department</option>
                        <option value="Marketing Department">Marketing Department</option>
                        <option value="Sales Department">Sales Department</option>
                        <option value="Human Resources Department">Human Resources Department</option>
                        <option value="IT Department">IT Department</option>
                        <option value="Finance Department">Finance Department</option>
                        <option value="Operations Department">Operations Department</option>
                        <option value="Logistics Department">Logistics Department</option>
                        <option value="Customer Support Department">Customer Support Department</option>
                        <option value="Legal Department">Legal Department</option>
                    </select>
                    <label for="category">Category:</label>
                    <input type="text" id="category" name="category" required>
                    <label for="planned-amt">Planned Amount:</label>
                    <input type="number" id="planned-amt" name="planned_amt" min="0" required>
                    <label for="actual-amt">Actual Amount:</label>
                    <input type="number" id="actual-amt" name="actual_amt" min="0">
                    <button class="btn" type="submit">Save Budget</button>
                </form>
            </section><br><br>
            <h3>All Budgets</h3><br>
            <form id="budget-search-form" style="margin-bottom: 1em;">
                <label>Budget Name:<input type="text" id="search-name"></label>
                <label style="margin-left: 1em;">Department:<input type="text" id="search-dept"></label>
                <label style="margin-left: 1em;">Category:<input type="text" id="search-cat"></label>
                <label style="margin-left: 1em;">Period Start:<input type="date" id="search-start"></label>
                <label style="margin-left: 1em;">Period End:<input type="date" id="search-end"></label>
                <button class="btn" type="submit" style="margin-left: 1em;">Search</button>
                <button class="btn" type="button" id="reset-filters" style="margin-left: 0.5em;">Reset</button>
            </form>
            <table class="table" border="1" id="budgets-table">
                <thead>
                    <tr>
                        <th>Budget Name</th>
                        <th>Period Start</th>
                        <th>Period End</th>
                        <th>Department</th>
                        <th>Category</th>
                        <th>Planned</th>
                        <th>Actual</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="budgets-table-body"></tbody>
            </table>
            <div id="edit-budget-item-modal" style="display:none;">
                <h3>Edit Budget Item</h3>
                <form id="edit-budget-item-form">
                    <input type="hidden" id="edit-item-id">
                    <label for="edit-department">Department:</label><br>
                    <select id="edit-department" required>
                        <option value="Marketing Department">Marketing Department</option>
                        <option value="Sales Department">Sales Department</option>
                        <option value="Human Resources Department">Human Resources Department</option>
                        <option value="IT Department">IT Department</option>
                        <option value="Finance Department">Finance Department</option>
                        <option value="Operations Department">Operations Department</option>
                        <option value="Logistics Department">Logistics Department</option>
                        <option value="Customer Support Department">Customer Support Department</option>
                        <option value="Legal Department">Legal Department</option>
                    </select>
                    <label for="edit-category">Category:</label><br>
                    <input type="text" id="edit-category">
                    <label for="edit-planned-amt">Planned Amount:</label><br>
                    <input type="number" id="edit-planned-amt" min="0" step="0.01" required>
                    <label for="edit-actual-amt">Actual Amount:</label><br>
                    <input type="number" id="edit-actual-amt" min="0" step="0.01" required>
                    <button class="btn" type="submit">Save</button>
                    <button class="btn" type="button" onclick="closeEditBudgetModal()">Cancel</button>
                </form>
            </div>
            <section id="forecasting">
                <h2>Dynamic forecasting</h2>
                <label for="forecast-name">Name of scenario:</label>
                <input type="text" id="forecast-name">
                <button class="btn" onclick="addParamRow()">➕ Add Parameter</button>
                <table class="table" id="forecast-params" border="1" style="margin-top:10px; width: 50%;">
                    <thead>
                        <tr>
                            <th>Key</th>
                            <th>Value</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
                <button class="btn" onclick="saveScenario()" style="margin-top:10px;">Save scenario</button><br><br>
                <h3>Forecast Scenarios</h3>
                <table class="table" border="1" id="scenarios-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Created At</th>
                            <th>Editor</th>
                        </tr>
                    </thead>
                    <tbody id="scenarios-table-body"></tbody>
                </table>
                <div id="edit-scenario-modal" style="display:none; position:fixed; top:20%; left:30%; background:#fff; border:1px solid #ccc; padding:20px; z-index:1000;">
                    <h3>Edit Forecast Scenario</h3>
                    <form id="edit-scenario-form">
                        <input type="hidden" id="edit-scenario-id">
                        <label for="edit-scenario-name">Name:</label><br>
                        <input type="text" id="edit-scenario-name" required><br><br>
                        <h4>Parameters</h4>
                        <table class="table" id="edit-params-table" border="1" style="width:100%">
                            <thead>
                                <tr>
                                    <th>Key</th>
                                    <th>Value</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                        <tbody id="edit-params-tbody"></tbody>
                        </table>
                        <button class="btn" type="button" onclick="addParamToEdit()">➕ Add Parameter</button><br><br>
                        <button class="btn" type="submit">Save Changes</button>
                        <button class="btn" type="button" onclick="closeEditScenarioModal()">Cancel</button>
                    </form>
                </div><br><br>
                <label for="scenario-select">Choose scenario for forecast:</label>
                <select id="scenario-select" onchange="generateForecast()" style="margin-left:10px;"></select>
                <table class="table" id="forecast-table" border="1" style="margin-top:10px; width: 70%;">
                    <thead>
                        <tr>
                            <th>Budget Name</th>
                            <th>Department</th>
                            <th>Category</th>
                            <th>Planned Amount</th>
                            <th>Forecast</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </section>
            <div class="chart-container">
                <h2>Лінійний графік: Виконання бюджету по місяцях</h2>
                <canvas id="lineChart"></canvas>
            </div>
            <div class="chart-container">
                <h2>Стовпчиковий графік: Порівняння витрат по категоріях</h2>
                <canvas id="barChart"></canvas>
            </div>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <script>
                let CURRENT_BUDGET_ID = null;
                const CURRENT_USER_ID = ${user_id};
                let items = [];
                let params = [];
                let editParams = [];
                let allBudgets = [];
                async function loadBudgets() {
                    try {
                        const res = await fetch('/api/budgets-with-items');
                        if (!res.ok) {
                            console.error('Failed to fetch budgets:', await res.text());
                            return;
                        }
                        const budgets = await res.json();
                        renderBudgetsTable(budgets);
                    } catch (err) {
                        console.error('Error loading budgets:', err);
                    }
                }
                function renderBudgetsTable(rows) {
                    const byBudget = rows.reduce((acc, r) => {
                        if (!acc[r.budget_id]) acc[r.budget_id] = { 
                            id: r.budget_id,
                            name: r.budget_name,
                            period_start: r.period_start,
                            period_end: r.period_end,
                            created_by: r.created_by,
                            items: []
                        };
                        acc[r.budget_id].items.push({
                            item_id:     r.item_id,
                            department:  r.department,
                            category:    r.category,
                            planned_amt: r.planned_amt,
                            actual_amt:  r.actual_amt
                        });
                        return acc;
                    }, {});
                    const tbody = document.getElementById('budgets-table-body');
                    tbody.innerHTML = Object.values(byBudget).map(b => {
                        const rowsHtml = b.items.map(it => \`
                            <tr onclick="CURRENT_BUDGET_ID=\${b.id};">
                                <td>\${b.name}</td>
                                <td>\${new Date(b.period_start).toLocaleDateString()}</td>
                                <td>\${new Date(b.period_end).toLocaleDateString()}</td>
                                <td>\${it.department}</td>
                                <td>\${it.category}</td>
                                <td>\${it.planned_amt}</td>
                                <td>\${it.actual_amt}</td>
                                <td>
                                    <button class="btn" onclick="openEditBudgetModal(\${b.id}, \${it.item_id || 'null'})">Edit</button>
                                    <button class="btn" onclick="deleteBudget(\${b.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                        return rowsHtml;
                    }).join('');
                }
                async function deleteBudget(budgetId) {
                    if (!confirm('Delete this budget?')) return;
                    const res = await fetch(\`/api/budgets/\${budgetId}\`, { method: 'DELETE' });
                    if (res.ok) {
                        loadBudgetsWithItems();
                    } else {
                        const err = await res.json();
                        alert(err.error || 'Can not delete budget');
                    }
                }
                async function loadBudgetsWithItems(filters = {}) {
                    const query = new URLSearchParams(filters).toString();
                    const res = await fetch(\`/api/budgets-with-items?\${query}\`);
                    const rows = await res.json();
                    renderBudgetsTable(rows);
                }
                document.getElementById('budget-search-form').addEventListener('submit', e => {
                    e.preventDefault();
                    const filters = {
                        name: document.getElementById('search-name').value.trim(),
                        department: document.getElementById('search-dept').value.trim(),
                        category: document.getElementById('search-cat').value.trim(),
                        date_from: document.getElementById('search-start').value,
                        date_to: document.getElementById('search-end').value
                    };
                    loadBudgetsWithItems(filters);
                });
                document.getElementById('reset-filters').addEventListener('click', () => {
                    document.getElementById('budget-search-form').reset();
                    loadBudgetsWithItems();
                });
                function openEditBudgetModal(budgetId, itemId) {
                    fetch(\`/api/budget-items/\${itemId}\`)
                    .then(res => {
                        if (!res.ok) throw new Error('Не вдалось завантажити дані');
                        return res.json();
                    })
                    .then(item => {
                        document.getElementById('edit-item-id').value = item.id;
                        document.getElementById('edit-department').value = item.department;
                        const catField = document.getElementById('edit-category');
                        catField.value = (!item.category || item.category === '-') ? '' : item.category;
                        document.getElementById('edit-planned-amt').value = item.planned_amt;
                        document.getElementById('edit-actual-amt').value = item.actual_amt;
                        document.getElementById('edit-budget-item-modal').style.display = 'block';
                    })
                    .catch(err => {
                        console.error(err);
                        alert('Помилка при завантаженні даних для редагування');
                    });
                }
                function closeEditBudgetModal() {
                    document.getElementById('edit-budget-item-modal').style.display = 'none';
                }
                document.getElementById('edit-budget-item-form').addEventListener('submit', function(e) {
                    e.preventDefault();
                    const id = document.getElementById('edit-item-id').value;
                    const rawCat = document.getElementById('edit-category').value.trim();
                    const data = {
                        department: document.getElementById('edit-department').value.trim(),
                        category:   rawCat === '' ? null : rawCat,
                        planned_amt: parseFloat(document.getElementById('edit-planned-amt').value),
                        actual_amt:  parseFloat(document.getElementById('edit-actual-amt').value)
                    };
                    fetch(\`/api/budget-items/\${id}\`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    })
                    .then(res => {
                        if (res.status === 400) return res.json().then(j => Promise.reject(j.error));
                        if (!res.ok) throw new Error('Server error');
                        return res.json();
                    })
                    .then(() => {
                        closeEditBudgetModal();
                        loadBudgetsWithItems();
                    })
                    .catch(err => {
                        console.error(err);
                        alert('Не вдалось зберегти зміни: ' + (err || ''));
                    });
                });
                function addParamRow() {
                    const idx = params.length;
                    params.push({ param_key: '', param_value: 1 });
                    const tr = document.createElement('tr');
                    tr.dataset.index = idx;
                    tr.innerHTML = \`
                        <td><input type="text" oninput="updateParamKey(\${idx}, this.value)" placeholder="Enter Key"></td>
                        <td><input type="number" step="0.01" oninput="updateParamValue(\${idx}, this.value)" placeholder="Enter Value"></td>
                        <td><button class="btn" onclick="removeParam(\${idx})">✖️</button></td>
                    \`;
                    document.querySelector('#forecast-params tbody').appendChild(tr);
                }
                function updateParamKey(idx, value) {
                    params[idx].param_key = value;
                }
                function updateParamValue(idx, value) {
                    params[idx].param_value = parseFloat(value);
                }
                function removeParam(idx) {
                    params.splice(idx, 1);
                    updateParamTable();
                }
                function updateParamTable() {
                    const tbody = document.querySelector('#forecast-params tbody');
                    tbody.innerHTML = '';
                    params.forEach((param, idx) => {
                        const tr = document.createElement('tr');
                        tr.dataset.index = idx;
                        tr.innerHTML = \`
                            <td><input type="text" value="\${param.param_key}" oninput="updateParamKey(\${idx}, this.value)" placeholder="Enter Key"></td>
                            <td><input type="number" step="0.01" value="\${param.param_value}" oninput="updateParamValue(\${idx}, this.value)" placeholder="Enter Value"></td>
                            <td><button class="btn" onclick="removeParam(\${idx})">✖️</button></td>
                        \`;
                        tbody.appendChild(tr);
                    });
                }
                function renderParamTable() {
                    const tbody = document.querySelector('#forecast-params tbody');
                    tbody.innerHTML = '';
                    params.forEach((p, i) => {
                      const tr = document.createElement('tr');
                      tr.innerHTML = \`
                        <td><input value="\${p.param_key}" oninput="params[\${i}].param_key=this.value"></td>
                        <td><input type="number" step="0.01" value="\${p.param_value}" oninput="params[\${i}].param_value=parseFloat(this.value)"></td>
                        <td><button class="btn" onclick="removeParam(\${i})">✖️</button></td>
                      \`;
                      tbody.appendChild(tr);
                    });
                }
                async function saveScenario() {
                    const name = document.getElementById('forecast-name').value;
                    const checkRes = await fetch(\`/api/forecasts?name=\${encodeURIComponent(name)}\`);
                    const checkData = await checkRes.json();
                    if (checkData.length > 0) {
                        alert('A forecast scenario with this name already exists. Please choose a different name.');
                        return;
                    }
                    if (!params || params.length === 0) {
                        alert('Please add at least one parameter.');
                        return;
                    }
                    const res = await fetch('/api/forecasts', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            name, 
                            entries: params,
                            created_by: CURRENT_USER_ID 
                        })
                    });
                    if (res.ok) {
                        alert('Forecast scenario saved successfully!');
                        loadScenariosTable();
                        location.reload();
                    } else {
                        const err = await res.json();
                        alert('Error creating forecast: ' + (err.error || 'Unknown error'));
                    }
                }
                async function loadScenarios() {
                    try {
                        const res = await fetch('/api/forecasts');
                        const scenarios = await res.json();
                        const selectElement = document.getElementById('scenario-select');
                        selectElement.innerHTML = '<option value="" disabled selected>Select scenario</option>';
                        scenarios.forEach(scenario => {
                            const option = document.createElement('option');
                            option.value = scenario.id;
                            option.textContent = scenario.name;
                            selectElement.appendChild(option);
                        });
                    } catch (err) {
                        console.error('Error loading scenarios:', err);
                        alert('Error loading scenarios');
                    }
                }
                function renderScenarios(scenarios) {
                    const tbody = document.getElementById('scenarios-table-body');
                    tbody.innerHTML = scenarios.map(s => \`
                        <tr>
                            <td>\${s.name}</td>
                            <td>\${new Date(s.created_at).toLocaleDateString()}</td>
                            <td>
                                <button class="btn" onclick="selectScenario(\${s.id})">Select</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                async function deleteScenario(id) {
                    if (!confirm('Are you sure you want to delete this scdenario?')) return;
                    try {
                        const res = await fetch(\`/api/forecasts/\${id}\`, { method: 'DELETE' });
                        if (res.status === 204) {
                            await loadScenariosTable();
                            alert('Scenario deleted successfully');
                        } else if (res.status === 404) {
                            alert('Scenario do not found or it is already delete');
                        } else {
                            const err = await res.json();
                            console.error(err);
                            alert('There is an error during deleting scenario');
                        }
                    } catch (err) {
                        console.error('Error in deleteScenario:', err);
                        alert('Can not connect to the server');
                    }
                }
                async function generateForecast() {
                    const scenarioId = document.getElementById('scenario-select').value;
                    if (!scenarioId) return;
                    const res = await fetch(\`/api/forecasts/\${scenarioId}/forecast-data\`);
                    if (!res.ok) {
                        alert('There is an error during forecast');
                        return;
                    }
                    const forecastData = await res.json();
                    const tbody = document.querySelector('#forecast-table tbody');
                    tbody.innerHTML = forecastData.map(row => \`
                        <tr>
                            <td>\${row.budget_name}</td>
                            <td>\${row.department}</td>
                            <td>\${row.category}</td>
                            <td>\${row.planned_amt}</td>
                            <td>\${row.forecast_amt}</td>
                        </tr>
                    \`).join('');
                }
                async function loadScenariosTable() {
                    const res = await fetch('/api/forecasts');
                    const list = await res.json();
                    const tbody = document.getElementById('scenarios-table-body');
                    tbody.innerHTML = list.map(s => \`
                        <tr>
                            <td>\${s.name}</td>
                            <td>\${new Date(s.created_at).toLocaleDateString()}</td>
                            <td>
                                <button class="btn" onclick="openEditScenarioModal(\${s.id})">Edit</button>
                                <button class="btn" onclick="deleteScenario(\${s.id})">Delete</button>
                            </td>
                        </tr>
                    \`).join('');
                }
                async function openEditScenarioModal(id) {
                    const res = await fetch(\`/api/forecasts/\${id}\`);
                    if (!res.ok) {
                        alert('Error loading scenario data');
                        return;
                    }
                    const scenario = await res.json();
                    document.getElementById('edit-scenario-id').value = scenario.id;
                    document.getElementById('edit-scenario-name').value = scenario.name;
                    editParams = scenario.entries || [];
                    renderEditParamsTable();
                    document.getElementById('edit-scenario-modal').style.display = 'block';
                }
                function closeEditScenarioModal() {
                    document.getElementById('edit-scenario-modal').style.display = 'none';
                }
                function renderParamsTable() {
                    const tbody = document.querySelector('#edit-params-table tbody');
                    tbody.innerHTML = editParams.map((p, i) => \`
                        <tr>
                            <td><input type="text" value="\${p.line_item}" oninput="editParams[\${i}].line_item=this.value"></td>
                            <td><input type="number" step="0.01" value="\${p.projected_value}" oninput="editParams[\${i}].projected_value=parseFloat(this.value)"></td>
                            <td><button class="btn" type="button" onclick="removeParam(\${i})">Delete</button></td>
                        </tr>
                    \`).join('');
                }
                document.getElementById('edit-scenario-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const id = document.getElementById('edit-scenario-id').value;
                    const name = document.getElementById('edit-scenario-name').value.trim();
                    const filteredParams = editParams
                        .filter(p => p.line_item && p.line_item.trim() !== '')
                        .map(p => ({
                            line_item: p.line_item.trim(),
                            projected_value: Number(p.projected_value) || 0,
                            period: p.period || new Date().toISOString().slice(0,10)
                        }));
                    if (filteredParams.length === 0) {
                        alert('Please add at least one valid parameter with a key.');
                        return;
                    }
                    const res = await fetch(\`/api/forecasts/\${id}\`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, entries: filteredParams })
                    });
                    if (res.ok) {
                        alert('Scenario updated successfully');
                        closeEditScenarioModal();
                        loadScenariosTable();
                    } else {
                        const err = await res.json().catch(() => null);
                        alert('Error updating forecast: ' + (err?.error || 'Unknown error'));
                    }
                });
                function addParamToEdit() {
                    editParams.push({ line_item: '', projected_value: 0, period: new Date().toISOString().slice(0,10) });
                    renderEditParamsTable();
                }
                function removeParamFromEdit(index) {
                    editParams.splice(index, 1);
                    renderEditParamsTable();
                }
                function renderEditParamsTable() {
                    const tbody = document.getElementById('edit-params-tbody');
                    tbody.innerHTML = editParams.map((p, i) => \`
                        <tr>
                            <td><input type="text" value="\${p.line_item}" oninput="editParams[\${i}].line_item=this.value"></td>
                            <td><input type="number" step="0.01" value="\${p.projected_value}" oninput="editParams[\${i}].projected_value=parseFloat(this.value)"></td>
                            <td><button class="btn" type="button" onclick="removeParamFromEdit(\${i})">Delete</button></td>
                        </tr>
                    \`).join('');
                }
                async function loadLineChartData() {
                    const res = await fetch('/api/forecast/budget-by-month');
                    const data = await res.json();
                    console.log('Received data for line chart:', data);
                    const months = data.map(row => row.month);
                    const planned = data.map(row => row.planned_amount);
                    const actual = data.map(row => row.actual_amount);
                    const ctxLine = document.getElementById('lineChart').getContext('2d');
                    new Chart(ctxLine, {
                        type: 'line',
                        data: {
                            labels: months,
                            datasets: [{
                                label: 'Заплановані витрати',
                                data: planned,
                                borderColor: 'rgba(75, 192, 192, 1)',
                                fill: false
                            }, {
                                label: 'Фактичні витрати',
                                data: actual,
                                borderColor: 'rgba(255, 99, 132, 1)',
                                fill: false
                            }]
                        }
                    });
                }
                async function loadBarChartData() {
                    const res = await fetch('/api/forecast/budget-by-category');
                    const data = await res.json();
                    const categories = data.map(row => row.category);
                    const planned = data.map(row => row.planned_amount);
                    const actual = data.map(row => row.actual_amount);
                    const ctxBar = document.getElementById('barChart').getContext('2d');
                    new Chart(ctxBar, {
                        type: 'bar',
                        data: {
                            labels: categories,
                            datasets: [{
                                label: 'Заплановані витрати',
                                data: planned,
                                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                                borderColor: 'rgba(75, 192, 192, 1)',
                                borderWidth: 1
                            }, {
                                label: 'Фактичні витрати',
                                data: actual,
                                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                                borderColor: 'rgba(255, 99, 132, 1)',
                                borderWidth: 1
                            }]
                        }
                    });
                }
                document.addEventListener('DOMContentLoaded', () => {
                fetch('/api/budget-performance').then(r => r.json())
                    .then(data => {
                        const labels  = data.map(d => new Date(d.month).toLocaleString('uk-UA', { month:'long', year:'numeric' }));
                        const planned = data.map(d => +d.planned);
                        const actual  = data.map(d => +d.actual);
                        new Chart(document.getElementById('lineChart'), {
                            type: 'line',
                            data: {
                                labels,
                                datasets: [
                                    {
                                        label: 'План',
                                        data: planned,
                                        borderColor: 'blue',
                                        fill: false
                                    },
                                    {
                                        label: 'Факт',
                                        data: actual,
                                        borderColor: 'green',
                                        fill: false
                                    }
                                ]
                            },
                            options: {
                                responsive: true,
                                scales: {
                                    y: { beginAtZero: true }
                                }
                            }
                        });
                    });
                fetch('/api/budget-category').then(r => r.json())
                    .then(data => {
                        const labels  = data.map(d => d.category);
                        const planned = data.map(d => +d.planned);
                        const actual  = data.map(d => +d.actual);
                        new Chart(document.getElementById('barChart'), {
                            type: 'bar',
                            data: {
                                labels,
                                datasets: [
                                    {
                                        label: 'План',
                                        data: planned
                                    },
                                    {
                                        label: 'Факт',
                                        data: actual
                                    }
                                ]
                            },
                            options: {
                                responsive: true,
                                scales: {
                                    y: { beginAtZero: true }
                                }
                            }
                        });
                    });
                    loadScenarios();
                    loadScenariosTable();
                    loadBudgets();
                    loadBudgetsWithItems();
                    document.getElementById('budget-form').addEventListener('submit', async function(e) {
                        e.preventDefault();
                        const periodStart = document.getElementById('budget-start').value;
                        const periodEnd = document.getElementById('budget-end').value;
                        if (periodStart > periodEnd) {
                            alert('Date of start can not be later that the end date');
                            return;
                        }
                        const payload = {
                            name: document.getElementById('budget-name').value.trim(),
                            period_start: periodStart,
                            period_end: periodEnd,
                            created_by: CURRENT_USER_ID,
                            items: [
                                {
                                    parent_item_id: null,
                                    department: document.getElementById('department').value,
                                    category: document.getElementById('category').value.trim(),
                                    planned_amt: parseFloat(document.getElementById('planned-amt').value),
                                    actual_amt: parseFloat(document.getElementById('actual-amt').value) || 0
                                }
                            ]
                        };
                        const res = await fetch('/api/budgets', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        if (res.ok) {
                            alert('Budget is saved');
                            this.reset();
                        } else {
                            const err = await res.json();
                            alert(err.error || 'There is an error during saving budget');
                        }
                    });
                });
            </script>
        `;
    }
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Dashboard</title>
            <link rel="stylesheet" href="/css/app.css" />
            <script>
                async function loadFinishedGoodsInventory() {
                    try {
                        const res  = await fetch('/api/finished-goods-inventory');
                        const list = await res.json();
                        const tbody = document.getElementById('finished-goods-inventory-table-body');
                        tbody.innerHTML = list.map(item => \`
                            <tr>
                                <td>\${item.product_name}</td>
                                <td>\${item.quantity}</td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error('Error loading finished goods inventory:', error);
                    }
                }
                function filterFinishedGoods() {
                    const q = document.getElementById('finished-goods-search').value.toLowerCase();
                    document.querySelectorAll('#finished-goods-inventory-table-body tr').forEach(tr => {
                        const name = tr.children[0].textContent.toLowerCase();
                        tr.style.display = name.includes(q) ? '' : 'none';
                    });
                }
                async function loadNewRoleResponsibilities() {
                    const res = await fetch('/all-responsibilities');
                    const all = await res.json();
                    const container = document.getElementById('new-resp-container');
                    container.innerHTML = '';
                    Object.entries(all).forEach(([dept, list]) => {
                        const fieldset = document.createElement('fieldset');
                        fieldset.style.border = '1px solid #ccc';
                        fieldset.style.padding = '8px';
                        fieldset.style.marginBottom = '12px';
                        fieldset.style.borderRadius = '4px';
                        const legend = document.createElement('legend');
                        legend.textContent = dept;
                        legend.style.fontWeight = 'bold';
                        fieldset.appendChild(legend);
                        list.forEach(item => {
                            const label = document.createElement('label');
                            label.style.display = 'block';
                            label.style.marginLeft = '10px';
                            const cb = document.createElement('input');
                            cb.type = 'checkbox';
                            cb.name = 'new-resp';
                            cb.value = item;
                            label.appendChild(cb);
                            label.append(\` \${item}\`);
                            fieldset.appendChild(label);
                        });
                        container.appendChild(fieldset);
                    });
                }
                async function createRole() {
                    const roleName = document.getElementById('new-role-name').value.trim();
                    const responsibilities = Array.from(
                        document.querySelectorAll('#new-resp-container input[name="new-resp"]:checked')
                    ).map(cb => cb.value);
                    if (!roleName) {
                        return alert('Please enter a role name.');
                    }
                    if (responsibilities.length === 0) {
                        return alert('Please select at least one responsibility.');
                    }
                    try {
                        const res = await fetch('/api/rolestable', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role_name: roleName, responsibilities })
                        });
                        const data = await res.json();
                        if (!res.ok) {
                            return alert(data.error || 'Failed to create role.');
                        }
                        alert(data.message);
                        document.getElementById('new-role-name').value = '';
                        document.querySelectorAll('#new-resp-container input[name="new-resp"]').forEach(cb => cb.checked = false);
                        loadRolesTable();
                    } catch (err) {
                        console.error('Error creating role:', err);
                        alert('Unexpected error, check console.');
                    }
                }
                async function deleteRole(roleId) {
                    if (!confirm('Are you sure you want to delete this role?')) return;
                    try {
                        const res = await fetch(\`/api/rolestable/\${roleId}\`, {
                            method: 'DELETE'
                        });
                        const data = await res.json();
                        if (!res.ok) {
                            alert(data.error || 'Failed to delete role.');
                            return;
                        }
                        alert(data.message);
                        loadRolesTable();
                    } catch (err) {
                        console.error('Error deleting role:', err);
                        alert('Unknown error, see console.');
                    }
                }
                async function loadRolesTable() {
                    try {
                        const response = await fetch('/api/rolestable');
                        const roles = await response.json();
                        const tableBody = document.getElementById('role-table-body');
                        tableBody.innerHTML = roles.map(role => \`
                            <tr>
                                <td>\${role.role_name}</td>
                                <td>\${Array.isArray(role.responsibilities)
                                        ? role.responsibilities.join(', ')
                                        : role.responsibilities}
                                </td>
                                <td>
                                    <button class="btn" onclick="openEditRoleModal('\${role.id}', '\${role.role_name}')">Edit</button>
                                    <button class="btn" onclick="deleteRole(\${role.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error('Error loading roles:', error);
                    }
                }
                async function openEditRoleModal(id, roleName) {
                    document.getElementById('edit-role-id').value = id;
                    document.getElementById('edit-role-name').value = roleName;
                    const allRespRes = await fetch('/all-responsibilities');
                    const allResponsibilities = await allRespRes.json();
                    const roleRes = await fetch(\`/api/rolestable/\${id}\`);
                    const roleData = await roleRes.json();
                    const selected = roleData.responsibilities || [];
                    const container = document.getElementById('edit-responsibilities-list');
                    container.innerHTML = '';
                    Object.entries(allResponsibilities).forEach(([dept, list]) => {
                        const fieldset = document.createElement('fieldset');
                        fieldset.style.border = "1px solid #ccc";
                        fieldset.style.padding = "10px";
                        fieldset.style.marginBottom = "15px";
                        fieldset.style.borderRadius = "5px";
                        const legend = document.createElement('legend');
                        legend.style.fontWeight = "bold";
                        legend.style.fontSize = "16px";
                        legend.textContent = dept;
                        fieldset.appendChild(legend);
                        list.forEach(resp => {
                            const checkbox = document.createElement('input');
                            checkbox.type = 'checkbox';
                            checkbox.name = 'responsibilities';
                            checkbox.value = resp;
                            if (selected.includes(resp)) checkbox.checked = true;
                            const label = document.createElement('label');
                            label.style.display = 'block';
                            label.appendChild(checkbox);
                            label.appendChild(document.createTextNode(' ' + resp));
                            fieldset.appendChild(label);
                        });
                        container.appendChild(fieldset);
                    });
                    document.getElementById('edit-role-modal').style.display = 'block';
                }
                function closeEditRoleModal() {
                    document.getElementById('edit-role-modal').style.display = 'none';
                }
                async function saveRole() {
                    const roleId = document.getElementById('edit-role-id').value;
                    const roleName = document.getElementById('edit-role-name').value.trim();
                    const responsibilities = Array.from(
                        document.querySelectorAll('#edit-responsibilities-list input[name="responsibilities"]:checked')
                    ).map(cb => cb.value);
                    if (!roleName) {
                        return alert('Role name is required.');
                    }
                    if (responsibilities.length === 0) {
                        return alert('Please select at least one responsibility.');
                    }
                    try {
                        const res = await fetch(\`/api/rolestable/\${roleId}\`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role_name: roleName, responsibilities })
                        });
                        const data = await res.json();
                        if (!res.ok) {
                            return alert(data.error || 'Failed to update role.');
                        }
                        await loadRolesTable();
                        closeEditRoleModal();
                    } catch (err) {
                        console.error('Error saving role:', err);
                        alert('Unexpected error, check console.');
                    }
                }
                async function addEmployee(event) {
                    event.preventDefault();
                    const first_name = document.getElementById('first_name').value;
                    const last_name = document.getElementById('last_name').value;
                    const role = document.getElementById('role').value;
                    const email = document.getElementById('email').value;
                    try {
                        const response = await fetch('/api/employees', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ first_name, last_name, role, email })
                        });
                        const result = await response.json();
                        if (response.ok) {
                            alert(result.message);
                        } else {
                            alert(result.error);
                        }
                        location.reload();
                    } catch (error) {
                        console.error("Error adding employee:", error);
                        alert("Failed to add employee.");
                    }
                }
                async function updateTable() {
                    const firstName = document.getElementById('first_name-search').value.trim();
                    const lastName = document.getElementById('last_name-search').value.trim();
                    const role = document.getElementById('role-search').value.trim();
                    const email = document.getElementById('email-search').value.trim();
                    try {
                        const response = await fetch(\`/api/search-workers?first_name=\${firstName}&last_name=\${lastName}&role=\${role}&email=\${email}\`);
                        const employees = await response.json();
                        const tableBody = document.getElementById('employee-table');
                        tableBody.innerHTML = employees.map(employee => \`
                            <tr>
                                <td>\${employee.first_name}</td>
                                <td>\${employee.last_name}</td>
                                <td>\${employee.role}</td>
                                <td>\${employee.email}</td>
                                <td>\${employee.password}</td>
                                <td>
                                    <button class="btn" onclick="openEditEmployeeModal(\${employee.id})">Edit</button>
                                    <button class="btn" onclick="deleteEmployee(\${employee.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error('Error fetching workers:', error);
                    }
                }
                async function loadRoles() {
                    try {
                        const response = await fetch('/api/roles');
                        const roles = await response.json();
                        const roleSelect = document.getElementById('role');
                        roleSelect.innerHTML = roles.map(role => \`
                            <option value="\${role.name}">\${role.name}</option>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading roles:", error);
                    }
                }
                async function loadRolesSearch(){
                    try {
                        const response = await fetch('/api/roles');
                        const roles = await response.json();
                        const roleSelectSearch = document.getElementById('role-search');
                        roleSelectSearch.innerHTML =\`
                            <option value="">All roles</option>\` + roles.map(role => \`
                            <option value="\${role.name}">\${role.name}</option>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading roles:", error);
                    }
                }
                async function openEditEmployeeModal(employeeId) {
                    try {
                        const response = await fetch(\`/api/employees/\${employeeId}\`);
                        const employee = await response.json();
                        document.getElementById('edit-employee-id').value = employee.id;
                        document.getElementById('edit-employee-first-name').value = employee.first_name;
                        document.getElementById('edit-employee-last-name').value = employee.last_name;
                        document.getElementById('edit-employee-email').value = employee.email;
                        document.getElementById('edit-employee-password').value = employee.password;
                        await loadRolesIntoDropdown(employee.role);
                        document.getElementById('edit-employee-modal').style.display = 'block';
                    } catch (error) {
                        console.error("Error opening edit employee modal:", error);
                    }
                }
                async function loadRolesIntoDropdown(selectedRole) {
                    try {
                        const response = await fetch('/api/roles');
                        const roles = await response.json();
                        const roleSelect = document.getElementById('edit-employee-role');
                        roleSelect.innerHTML = roles.map(role => \`
                            <option value="\${role.id}" \${role.name === selectedRole ? 'selected' : ''}>\${role.name}</option>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading roles:", error);
                    }
                }
                function validatePassword(password) {
                    if (password.length < 16 || password.length > 35) {
                        const passwordField = document.getElementById('edit-employee-password');
                        passwordField.style.borderColor = 'red';
                        const errorMessage = document.getElementById('password-error');
                        errorMessage.style.display = 'block';
                        return false;
                    } else {
                        document.getElementById('edit-employee-password').style.borderColor = '';
                        document.getElementById('password-error').style.display = 'none';
                        return true;
                    }
                }
                async function updateEmployee() {
                    const id = document.getElementById('edit-employee-id').value;
                    const first_name = document.getElementById('edit-employee-first-name').value.trim();
                    const last_name = document.getElementById('edit-employee-last-name').value.trim();
                    const role = document.getElementById('edit-employee-role').value.trim();
                    const email = document.getElementById('edit-employee-email').value.trim();
                    const password = document.getElementById('edit-employee-password').value.trim();
                    if (!validatePassword(password)) {
                        return;
                    }
                    if (!first_name || !last_name || !role || !email || !password) {
                        alert("All fields are required.");
                        return;
                    }
                    try {
                        const response = await fetch('/api/update-employee', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id, first_name, last_name, role, email, password })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        document.getElementById('edit-employee-modal').style.display = 'none';
                        loadEmployeeTable();
                    } catch (error) {
                        console.error("Error updating employee:", error);
                    }
                }
                async function loadEmployeeTable() {
                    try {
                        const response = await fetch('/api/employees');
                        const employees = await response.json();
                        const table = document.getElementById('employee-table');
                        table.innerHTML = employees.map(employee => \`
                            <tr>
                                <td>\${employee.first_name}</td>
                                <td>\${employee.last_name}</td>
                                <td>\${employee.role}</td>
                                <td>\${employee.email}</td>
                                <td>\${employee.password}</td>
                                <td>
                                    <button class="btn" onclick="openEditEmployeeModal(\${employee.id})">Edit</button>
                                    <button class="btn" onclick="deleteEmployee(\${employee.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading employees:", error);
                    }
                }
                async function deleteEmployee(id) {
                    if (!confirm("Are you sure you want to delete this employee?")) return;
                    try {
                        const response = await fetch(\`/api/employees/\${id}\`, { method: 'DELETE' });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadEmployeeTable();
                    } catch (error) {
                        console.error("Error deleting employee:", error);
                    }
                }
                async function deletePurchaseHistory(id) {
                    if (!confirm("Are you sure you want to delete this record?")) return;
                    try {
                        const response = await fetch(\`/api/purchase-history/\${id}\`, { method: 'DELETE' });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadPurchaseHistory();
                    } catch (error) {
                        console.error("Error deleting purchase history record:", error);
                    }
                }
                const LOW_STOCK_THRESHOLD = 150;
                async function loadWarehouseInventory() {
                    const filter = document.getElementById('inventory-material-filter').value.toLowerCase();
                    const res = await fetch('/api/warehouse-inventory');
                    const data = await res.json();
                    const filtered = data.filter(item =>
                        item.material_name.toLowerCase().includes(filter)
                    );
                    renderWarehouseInventory(filtered);
                    renderLowStockAlert(filtered);
                }
                function renderWarehouseInventory(list) {
                    const tbody = document.getElementById('warehouse-inventory-table');
                    tbody.innerHTML = list.map(item => {
                        const cls = item.total_quantity < LOW_STOCK_THRESHOLD ? 'low-stock' : '';
                        return \`
                            <tr class="\${cls}">
                                <td>\${item.material_name}</td>
                                <td>\${item.total_quantity}</td>
                            </tr>
                        \`;
                    }).join('');
                }
                function renderLowStockAlert(list) {
                    const low = list.filter(item => item.total_quantity < LOW_STOCK_THRESHOLD);
                    const alertDiv = document.getElementById('warehouse-alerts');
                    if (low.length) {
                        alertDiv.textContent =
                            '⚠️ Low stock: ' +
                            low.map(i => \`\${i.material_name} (\${i.total_quantity})\`).join(', ');
                    } else {
                        alertDiv.textContent = '';
                    }
                }
                async function loadPurchaseHistory() {
                    const material = document.getElementById('ph-material-filter').value.trim();
                    const from = document.getElementById('ph-date-from').value;
                    const to = document.getElementById('ph-date-to').value;
                    const params = new URLSearchParams();
                    if (material) params.append('material', material);
                    if (from) params.append('date_from', from);
                    if (to) params.append('date_to', to);
                    const url = '/api/purchase-history' + (params.toString() ? \`?\${params}\` : '');
                    const res = await fetch(url);
                    const data = await res.json();
                    renderPurchaseHistoryTable(data);
                }
                async function renderPurchaseHistoryTable(data) {
                    try {
                        const table = document.getElementById('purchase-history-table');
                        table.innerHTML = data.map(entry => \`
                            <tr>
                                <td>\${entry.material_name}</td>
                                <td>\${entry.quantity}</td>
                                <td>\${entry.supplier}</td>
                                <td>\${entry.status}</td>
                                <td>\${entry.notes || 'No notes'}</td>
                                <td>\${entry.defect_report || 'No defects'}</td>
                                <td>\${new Date(entry.completed_at).toLocaleString()}</td>
                                <td>
                                    <button class="btn" onclick="deletePurchaseHistory(\${entry.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error('Error loading purchase history:', error);
                    }
                }
                async function updateDefectReport(id) {
                    const defect_report = document.getElementById(\`defect-report-\${id}\`).value.trim();
                    if (!defect_report || defect_report.length < 5) {
                        alert("Defect report must be at least 5 characters long.");
                        return;
                    }
                    try {
                        const response = await fetch('/api/update-defect-report', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id, defect_report })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadActivePurchaseRequests();
                    } catch (error) {
                        console.error('Error updating defect report:', error);
                    }
                }
                async function loadActivePurchaseRequests() {
                    try {
                        const userId = ${user_id};
                        const response = await fetch(\`/api/purchase-requests/\${userId}\`);
                        const requests = await response.json();
                        const table = document.getElementById('active-purchase-requests-table');
                        table.innerHTML = requests.map(r => \`
                            <tr>
                                <td>\${r.material_name}</td>
                                <td>\${r.quantity}</td>
                                <td>\${r.supplier}</td>
                                <td>
                                    <select id="status-\${r.id}" onchange="updatePurchaseRequestStatus(\${r.id})">
                                        <option value="Pending" \${r.status === 'Pending' ? 'selected' : ''}>Pending</option>
                                        <option value="In progress" \${r.status === 'In progress' ? 'selected' : ''}>In Progress</option>
                                        <option value="Rejected" \${r.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
                                        <option value="Completed" \${r.status === 'Completed' ? 'selected' : ''}>Completed</option>
                                    </select>
                                </td>
                                <td>\${r.notes || 'No notes'}</td>
                                <td>
                                    <textarea id="defect-report-\${r.id}" placeholder="Enter defect report..." rows="2">\${r.defect_report || ''}</textarea>
                                    <button class="btn" onclick="updateDefectReport(\${r.id})">Save</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error('Error loading active purchase requests:', error);
                    }
                }
                async function updatePurchaseRequestStatus(id) {
                    const status = document.getElementById(\`status-\${id}\`).value;
                    try {
                        const response = await fetch('/api/update-purchase-status', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id, status })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadActivePurchaseRequests();
                        location.reload();
                    } catch (error) {
                        console.error('Error updating purchase request status:', error);
                    }
                }
                async function loadControlUsersForSuppliers(selectId, selectedUserId = null) {
                    try {
                        const response = await fetch('/api/control-users-supplies');
                        const controlUsers = await response.json();
                        const select = document.getElementById(selectId);
                        select.innerHTML = controlUsers.map(u => 
                            \`<option value="\${u.id}" \${u.id == selectedUserId ? "selected" : ""}>\${u.first_name} \${u.last_name}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading control users:", error);
                    }
                }
                async function loadSuppliers() {
                    try {
                        const response = await fetch('/api/suppliers');
                        const suppliers = await response.json();
                        const table = document.getElementById('suppliers-table');
                        table.innerHTML = suppliers.map(s => \`
                            <tr>
                                <td>\${s.name}</td>
                                <td>\${s.contact_info || 'No contact info'}</td>
                                <td>\${s.control_user_name || 'Not assigned'}</td>
                                <td>\${s.materials ? s.materials.join(', ') : 'No materials assigned'}</td>
                                <td>
                                    <button class="btn" onclick='openEditSupplierModal(\${JSON.stringify(s)})'>Edit</button>
                                    <button class="btn" onclick="deleteSupplier(\${s.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading suppliers:", error);
                    }
                }
                async function openEditSupplierModal(supplier) {
                    document.getElementById('edit-supplier-id').value = supplier.id;
                    document.getElementById('edit-supplier-name').value = supplier.name;
                    document.getElementById('edit-supplier-contact').value = supplier.contact_info || '';
                    await loadControlUsersForSuppliers('edit-supplier-control-user-list', supplier.control_user_id);
                    await loadSupplierMaterials('edit-supplier-materials', supplier.materials);
                    document.getElementById('edit-supplier-modal').style.display = 'block';
                }
                async function loadSupplierMaterials(selectId, selectedMaterials = []) {
                    try {
                        const response = await fetch('/api/suppliers/materials');
                        const materials = await response.json();
                        const select = document.getElementById(selectId);
                        select.innerHTML = materials.map(material => 
                            \`<option value="\${material}" \${selectedMaterials.includes(material) ? 'selected' : ''}>\${material}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading materials:", error);
                    }
                }
                async function updateSupplier() {
                    const id = document.getElementById('edit-supplier-id').value;
                    const name = document.getElementById('edit-supplier-name').value.trim();
                    const contact_info = document.getElementById('edit-supplier-contact').value.trim();
                    const control_user_id = document.getElementById('edit-supplier-control-user-list').value;
                    const materials = Array.from(document.getElementById('edit-supplier-materials').selectedOptions).map(option => option.value);
                    if (!name) {
                        alert("Supplier name is required.");
                        return;
                    }
                    try {
                        const response = await fetch(\`/api/suppliers/\${id}\`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, contact_info, control_user_id, materials })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        document.getElementById('edit-supplier-modal').style.display = 'none';
                        loadSuppliers();
                    } catch (error) {
                        console.error("Error updating supplier:", error);
                    }
                }
                async function updatePurchaseRequest() {
                    const id = document.getElementById('edit-purchase-id').value;
                    const material_name = document.getElementById('edit-purchase-material-list').value;
                    const quantity = document.getElementById('edit-purchase-quantity').value;
                    const supplier_id = document.getElementById('edit-purchase-supplier-list').value;
                    const notes = document.getElementById('edit-purchase-notes').value;
                    try {
                        const response = await fetch(\`/api/purchase-requests/\${id}\`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ material_name, quantity, supplier_id, notes })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        document.getElementById('edit-purchase-modal').style.display = 'none';
                        loadPurchaseRequests();
                        location.reload();
                    } catch (error) {
                        console.error("Error updating purchase request:", error);
                    }
                }
                async function loadSupplierList(selectId, selectedSupplierId = null) {
                    try {
                        const response = await fetch('/api/suppliers');
                        const suppliers = await response.json();
                        const select = document.getElementById(selectId);
                        select.innerHTML = suppliers.map(s => 
                            \`<option value="\${s.id}" \${s.id === selectedSupplierId ? 'selected' : ''}>\${s.name}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading suppliers:", error);
                    }
                }
                async function createSupplier() {
                    const name = document.getElementById('supplier-name').value.trim();
                    const contact_info = document.getElementById('supplier-contact').value.trim();
                    const control_user_id = document.getElementById('supplier-control-user-list').value;
                    const materials = Array.from(document.getElementById('supplier-materials').selectedOptions)
                                            .map(option => option.value);
                    if (!name) {
                        alert("Supplier name is required.");
                        return;
                    }
                    try {
                        const response = await fetch('/api/suppliers', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, contact_info, control_user_id, materials })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert("Supplier added successfully");
                        location.reload();
                    } catch (error) {
                        console.error("Error adding supplier:", error);
                    }
                }
                async function deleteSupplier(id) {
                    if (!confirm("Are you sure you want to delete this supplier?")) return;
                    try {
                        const response = await fetch(\`/api/suppliers/\${id}\`, { method: 'DELETE' });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadSuppliers();
                        location.reload();
                    } catch (error) {
                        console.error("Error deleting supplier:", error);
                    }
                }
                async function openEditPurchaseModal(request) {
                    document.getElementById('edit-purchase-id').value = request.id;
                    document.getElementById('edit-purchase-quantity').value = request.quantity;
                    document.getElementById('edit-purchase-notes').value = request.notes;
                    await loadMaterialsIntoDropdown('edit-purchase-material-list', request.material_name);
                    await loadSupplierList('edit-purchase-supplier-list', request.supplier_id); 
                    document.getElementById('edit-purchase-modal').style.display = 'block';
                }
                async function loadMaterialsIntoDropdown(selectId, selectedMaterial = null) {
                    try {
                        const response = await fetch('/api/materials');
                        const materials = await response.json();
                        const select = document.getElementById(selectId);
                        select.innerHTML = materials.map(m => 
                            \`<option value="\${m}" \${m === selectedMaterial ? 'selected' : ''}>\${m}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading materials:", error);
                    }
                }
                async function loadPurchaseRequests() {
                    try {
                        const response = await fetch('/api/purchase-requests');
                        const requests = await response.json();
                        const table = document.getElementById('purchase-requests-table');
                        table.innerHTML = requests.map(r => \`
                            <tr>
                                <td>\${r.material_name}</td>
                                <td>\${r.quantity}</td>
                                <td>\${r.supplier}</td>
                                <td>\${r.status}</td>
                                <td>\${r.notes}</td>
                                <td>
                                    <button class="btn" onclick='openEditPurchaseModal(\${JSON.stringify(r)})'>Edit</button>
                                    <button class="btn" onclick="deletePurchaseRequest(\${r.id})">Delete</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading purchase requests:", error);
                    }
                }
                async function loadMaterials() {
                    try {
                        const response = await fetch('/api/materials');
                        const materials = await response.json();
                        const select = document.getElementById('purchase-material-list');
                        select.innerHTML = materials.map(m => 
                            \`<option value="\${m}">\${m}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading materials:", error);
                    }
                }
                async function loadSuppliersMaterials() {
                    try {
                        const response = await fetch('/api/suppliers/materials');
                        const materials = await response.json();
                        const select = document.getElementById('supplier-materials');
                        select.innerHTML = materials.map(material => 
                            \`<option value="\${material}">\${material}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading materials:", error);
                    }
                }
                async function createPurchaseRequest() {
                    const material_name = document.getElementById('purchase-material-list').value;
                    const quantity = document.getElementById('purchase-quantity').value;
                    const supplier_id = document.getElementById('purchase-supplier-list').value;
                    const notes = document.getElementById('purchase-notes').value;
                    try {
                        const response = await fetch('/api/purchase-requests', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ material_name, quantity, supplier_id, notes })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        location.reload();
                    } catch (error) {
                        console.error("Error creating purchase request:", error);
                    }
                }
                async function deletePurchaseRequest(id) {
                    await fetch(\`/api/purchase-requests/\${id}\`, { method: 'DELETE' });
                    alert("Purchase request deleted successfully");
                    loadPurchaseRequests();
                    location.reload();
                }
                async function loadPerformance() {
                    const mat = document.getElementById('perf-material-filter').value.trim();
                    const from = document.getElementById('perf-date-from').value;
                    const to = document.getElementById('perf-date-to').value;
                    const params = new URLSearchParams();
                    if (mat) params.append('material', mat);
                    if (from) params.append('date_from', from);
                    if (to) params.append('date_to', to);
                    const url = '/api/worker-performance' + (params.toString() ? \`?\${params}\` : '');
                    const res = await fetch(url);
                    const data = await res.json();
                    loadWorkerPerformance(data);
                }
                async function loadWorkerPerformance(data) {
                    try {
                        const table = document.getElementById('workers-performance-table');
                        table.innerHTML = data.map(entry => {
                            let materialsList;
                            try {
                                materialsList = JSON.parse(entry.materials)
                                    .map(m => \`\${m.name}: \${m.quantity}\`)
                                    .join('<br>');
                            } catch (e) {
                                materialsList = 'Invalid data';
                            }
                            const formattedDate = new Date(entry.created_at).toLocaleString();
                            return \`
                                <tr>
                                    <td>\${entry.product_name}</td>
                                    <td>\${entry.quantity}</td>
                                    <td>\${materialsList}</td>
                                    <td>\${entry.responsible_user}</td>
                                    <td>\${entry.control_user}</td>
                                    <td>\${entry.quality_score}</td>
                                    <td>\${entry.status}</td>
                                    <td>\${entry.notes}</td>
                                    <td>\${formattedDate}</td>
                                    <td>
                                        <button class="btn" onclick="deleteWorkerPerformance(\${entry.id})">Delete</button>
                                    </td>
                                </tr>
                            \`;
                        }).join('');
                    } catch (error) {
                        console.error('Error loading worker performance data:', error);
                    }
                }
                async function deleteWorkerPerformance(id) {
                    if (!confirm("Are you sure you want to delete this record?")) return;
                    try {
                        const response = await fetch(\`/api/worker-performance/\${id}\`, { method: 'DELETE' });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadPerformance();
                        location.reload();
                    } catch (error) {
                        console.error("Error deleting worker performance record:", error);
                    }
                }
                async function loadQualityControlOrders() {
                    const userId = ${user_id};
                    try {
                        const response = await fetch(\`/api/quality-control-orders/\${userId}\`);
                        const orders = await response.json();
                        const table = document.getElementById('quality-control-table');
                        table.innerHTML = orders.map(o => \`
                            <tr>
                                <td>\${o.product_name}</td>
                                <td>\${o.quantity}</td>
                                <td>\${o.responsible_first_name} \${o.responsible_last_name}</td>
                                <td>
                                    <input type="number" id="quality-score-\${o.id}" min="0" max="10" placeholder="0-10" required>
                                </td>
                                <td>
                                    <select id="status-\${o.id}">
                                        <option value="Rejected">Rejected</option>
                                        <option value="Approved">Approved</option>
                                    </select>
                                </td>
                                <td>
                                    <textarea id="notes-\${o.id}" rows="4" placeholder="Add notes..." required></textarea>
                                </td>
                                <td>
                                    <button class="btn" onclick="updateQualityStatus(\${o.id})">Save</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading quality control orders:", error);
                    }
                }
                async function updateQualityStatus(orderId) {
                    const qualityScore = document.getElementById(\`quality-score-\${orderId}\`).value.trim();
                    const status = document.getElementById(\`status-\${orderId}\`).value;
                    const notes = document.getElementById(\`notes-\${orderId}\`).value.trim();
                    if (!qualityScore && status === 'Approved') {
                        alert('Please enter a quality score.');
                        return;
                    }
                    if ((!notes || notes.length < 5) && status === 'Approved') {
                        alert('Please enter notes with at least 5 characters.');
                        return;
                    }
                    try {
                        const response = await fetch('/api/update-quality-status', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: orderId, status, quality_score: qualityScore, notes })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        loadQualityControlOrders();
                        location.reload();
                    } catch (error) {
                        console.error("Error updating quality status:", error);
                    }
                }
                async function loadControlUsers() {
                    try {
                        const response = await fetch('/api/control-users');
                        const controlUsers = await response.json();
                        const select = document.getElementById('control-user-list');
                        select.innerHTML = controlUsers.map(u => 
                            \`<option value="\${u.id}">\${u.first_name} \${u.last_name}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading control users:", error);
                    }
                }
                async function loadUserOrders() {
                    const userId = ${user_id};
                    try {
                        const response = await fetch('/api/production-orders/user/' + userId);
                        const orders = await response.json();
                        const table = document.getElementById('user-orders-table');
                        table.innerHTML = orders.map(o => \`
                        <tr>
                            <td>\${o.product_name}</td>
                            <td>\${o.quantity}</td>
                            <td>
                                <ul>
                                    \${o.materials.map(m => \`<li>\${m.name}: \${m.quantity}</li>\`).join('')}
                                </ul>
                            </td>
                            <td>
                                <select onchange="updateOrderStatus(\${o.id}, this.value)">
                                    <option value="Preparing" \${o.status === 'Preparing' ? 'selected' : ''}>Preparing</option>
                                    <option value="In progress" \${o.status === 'In progress' ? 'selected' : ''}>In Progress</option>
                                    <option value="Rejected" \${o.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
                                    <option value="Completed" \${o.status === 'Completed' ? 'selected' : ''}>Completed</option>
                                </select>
                            </td>
                            <td>
                                <textarea id="order-notes-\${o.id}" onchange="updateOrderNotes(\${o.id})" placeholder="Add notes...">\${o.notes || ''}</textarea>
                            </td>
                        </tr>
                        \`).join('');
                    } catch (error) {
                        console.error("Error loading user production orders:", error);
                    }
                }
                async function updateOrderNotes(orderId) {
                    const notes = document.getElementById(\`order-notes-\${orderId}\`).value;
                    try {
                        const response = await fetch('/api/update-order-notes', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: orderId, notes })
                        });
                        const result = await response.json();
                        alert(result.message);
                    } catch (error) {
                        console.error("Error updating order notes:", error);
                    }
                }
                async function updateOrderStatus(orderId, newStatus) {
                    try {
                        const response = await fetch('/api/update-order-status', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: orderId, status: newStatus })
                        });
                        const result = await response.json();
                        alert(result.message);
                        loadUserOrders();
                        location.reload();
                    } catch (error) {
                        console.error("Error updating order status:", error);
                    }
                }
                async function loadUsers() {
                    try {
                        const response = await fetch('/api/users');
                        const users = await response.json();
                        const select = document.getElementById('user-list');
                        if (!Array.isArray(users) || users.length === 0) {
                            console.warn('No users found or invalid users data:', users);
                            select.innerHTML = \`<option value="">No users available</option>\`;
                            return;
                        }
                        select.innerHTML = users.map(u => 
                            \`<option value="\${u.id}">\${u.first_name} \${u.last_name}</option>\`
                        ).join('');
                    } catch (error) {
                        console.error("Error loading users:", error);
                    }
                }
                async function loadProducts() {
                    try {
                        const response = await fetch('/api/products', { cache: 'no-cache' });
                        const products = await response.json();
                        const select = document.getElementById('product-list');
                        const table = document.getElementById('products-table');
                        select.innerHTML = products.map(p => 
                            \`<option value="\${p.id}">\${p.name}</option>\`
                        ).join('');
                        table.innerHTML = products.map(p => {
                            let materialsList = 'No materials';
                            if (p.materials) {
                                try {
                                    const materials = typeof p.materials === "string" ? JSON.parse(p.materials) : p.materials;
                                    materialsList = Array.isArray(materials)
                                        ? materials.map(m => \`\${m.name} (\${m.quantity})\`).join(', ')
                                        : 'Invalid format';
                                } catch (error) {
                                    materialsList = 'Invalid data';
                                }
                            }
                            return \`
                                <tr>
                                    <td>\${p.name}</td>
                                    <td>\${materialsList}</td>
                                    <td>
                                        <button class="btn" onclick='openEditModal(\${JSON.stringify(p)})'>Edit</button>
                                        <button class="btn" onclick="deleteProduct(\${p.id})">Delete</button>
                                    </td>
                                </tr>
                            \`;
                        }).join('');
                    } catch (error) {
                        console.error("Error loading products:", error);
                    }
                }
                async function updateProduct() {
                    const id = document.getElementById('edit-product-id').value;
                    const name = document.getElementById('edit-product-name').value;
                    const materialInputs = document.querySelectorAll('#edit-materials-container .material-name');
                    const quantityInputs = document.querySelectorAll('#edit-materials-container .material-quantity');
                    let materials = [];
                    for (let i = 0; i < materialInputs.length; i++) {
                        const materialName = materialInputs[i].value;
                        const quantity = quantityInputs[i].value;
                        if (materialName && quantity) {
                            materials.push({ name: materialName, quantity: quantity });
                        }
                    }
                    if (!name || materials.length === 0) {
                        alert('Please enter a product name and at least one material.');
                        return;
                    }
                    const response = await fetch('/api/products/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, materials })
                    });
                    alert('Product updated successfully');
                    document.getElementById('edit-product-modal').style.display = 'none';
                    loadProducts();
                    location.reload();
                }
                async function loadProductsList() {
                    const response = await fetch('/api/products');
                    const products = await response.json();
                    const select = document.getElementById('product-list');
                    select.innerHTML = products.map(p => 
                        \`<option value="\${p.id}">\${p.name}</option>\`
                    ).join('');
                }
                async function startProduction() {
                    const product_id = document.getElementById('product-list').value;
                    const quantity = document.getElementById('quantity').value;
                    const responsible_user_id = document.getElementById('user-list').value;
                    const responsible_for_control_user_id = document.getElementById('control-user-list').value;
                    if (quantity <= 0) {
                        alert('Quantity must be greater than 0');
                        return;
                    }
                    try {
                        const response = await fetch('/api/start-production', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ product_id, quantity, responsible_user_id, responsible_for_control_user_id })
                        });
                        alert('Production started successfully');
                        loadProductionOrders();
                        location.reload();
                    } catch (error) {
                        console.error("Error starting production:", error);
                    }
                }
                async function loadProductionOrders() {
                    try {
                        const responseOrders = await fetch('/api/production-orders');
                        const orders = await responseOrders.json();
                        const responseUsers = await fetch('/api/users');
                        const users = await responseUsers.json();
                        const responseProducts = await fetch('/api/products');
                        const products = await responseProducts.json();
                        const responseControlUsers = await fetch('/api/control-users');
                        const controlUsers = await responseControlUsers.json();
                        const table = document.getElementById('orders-table');
                        table.innerHTML = orders.map(o => {
                            let responsiblePerson = o.responsible_first_name && o.responsible_last_name
                                ? \`\${o.responsible_first_name} \${o.responsible_last_name}\`
                                : 'Not assigned';
                            let controlPerson = o.control_first_name && o.control_last_name
                                ? \`\${o.control_first_name} \${o.control_last_name}\`
                                : 'Not assigned';
                            return \`
                                <tr>
                                    <td>\${o.product_name}</td>
                                    <td>\${o.quantity}</td>
                                    <td>\${o.status}</td>
                                    <td>\${responsiblePerson}</td>
                                    <td>\${controlPerson}</td>
                                    <td>
                                        <button class="btn" onclick='openEditOrderModal(\${JSON.stringify(o)}, \${JSON.stringify(products)}, \${JSON.stringify(users)}, \${JSON.stringify(controlUsers)})'>Edit</button>
                                        <button class="btn" onclick="deleteOrder(\${o.id})">Delete</button>
                                    </td>
                                </tr>
                            \`;
                        }).join('');
                    } catch (error) {
                        console.error("Error loading production orders:", error);
                    }
                }
                async function updateResponsible(order_id, responsible_user_id) {
                    const response = await fetch('/api/update-responsible', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ order_id, responsible_user_id })
                    });
                    alert('Responsible person updated successfully');
                    loadProductionOrders();
                }
                async function deleteOrder(id) {
                    await fetch('/api/production-orders/' + id, { method: 'DELETE' });
                    loadProductionOrders();
                }
                function addMaterialField(name = '', quantity = '', isEdit = false) {
                    const container = isEdit ? document.getElementById('edit-materials-container') : document.getElementById('materials-container');
                    const div = document.createElement('div');
                    div.innerHTML = \`
                        <input type="text" placeholder="Material Name" class="material-name" value="\${name}">
                        <input type="text" placeholder="Quantity" class="material-quantity" value="\${quantity}">
                        <button class="btn" type="button" onclick="removeMaterialField(this)">❌</button>
                    \`;
                    container.appendChild(div);
                }
                function removeMaterialField(button) {
                    button.parentElement.remove();
                }
                async function createProduct() {
                    try {
                        const name = document.getElementById('product-name').value;
                        const materialInputs = document.querySelectorAll('.material-name');
                        const quantityInputs = document.querySelectorAll('.material-quantity');
                        let materials = [];
                        for (let i = 0; i < materialInputs.length; i++) {
                            const materialName = materialInputs[i].value;
                            const quantity = quantityInputs[i].value;
                            if (materialName && quantity) {
                                materials.push({ name: materialName, quantity: quantity });
                            }
                        }
                        if (!name || materials.length === 0) {
                            alert('Please enter a product name and at least one material.');
                            return;
                        }
                        const response = await fetch('/api/products', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, materials })
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            alert(result.error);
                            return;
                        }
                        alert(result.message);
                        location.reload();
                    } catch (error) {
                        console.error("Error creating product:", error);
                    }
                }
                async function deleteProduct(id) {
                    try {
                        const response = await fetch('/api/products/' + id, { method: 'DELETE' });
                        const result = await response.text();
                        if (!response.ok) {
                            alert('Product cannot be deleted, it is used');
                            return;
                        }
                        alert(result);
                        location.reload();
                    } catch (error) {
                        console.error("Error deleting product:", error);
                        alert("An error occurred while deleting the product.");
                    }
                }
                function openEditModal(product) {
                    document.getElementById('edit-product-id').value = product.id;
                    document.getElementById('edit-product-name').value = product.name;
                    const materialsContainer = document.getElementById('edit-materials-container');
                    materialsContainer.innerHTML = '';
                    const materials = typeof product.materials === "string" ? JSON.parse(product.materials) : product.materials;
                    materials.forEach(material => {
                        addMaterialField(material.name, material.quantity, true);
                    });
                    document.getElementById('edit-product-modal').style.display = 'block';
                }
                function openEditOrderModal(order, products, users, controlUsers) {
                    document.getElementById('edit-order-id').value = order.id;
                    document.getElementById('edit-quantity').value = order.quantity;
                    const productSelect = document.getElementById('edit-product-list');
                    productSelect.innerHTML = products.map(p => 
                        \`<option value="\${p.id}" \${p.id == order.product_id ? "selected" : ""}>\${p.name}</option>\`
                    ).join('');
                    const userSelect = document.getElementById('edit-user-list');
                    userSelect.innerHTML = users.map(u => 
                        \`<option value="\${u.id}" \${u.id == order.responsible_user_id ? "selected" : ""}>\${u.first_name} \${u.last_name}</option>\`
                    ).join('');
                    const controlUserSelect = document.getElementById('edit-control-user-list');
                    controlUserSelect.innerHTML = controlUsers.map(u => 
                        \`<option value="\${u.id}" \${u.id == order.responsible_for_control_user_id ? "selected" : ""}>\${u.first_name} \${u.last_name}</option>\`
                    ).join('');
                    document.getElementById('edit-order-modal').style.display = 'block';
                }
                async function updateOrder() {
                    const id = document.getElementById('edit-order-id').value;
                    const product_id = document.getElementById('edit-product-list').value;
                    const quantity = document.getElementById('edit-quantity').value;
                    const responsible_user_id = document.getElementById('edit-user-list').value;
                    const responsible_for_control_user_id = document.getElementById('edit-control-user-list').value;
                    try {
                        const response = await fetch('/api/update-order', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id, product_id, quantity, responsible_user_id, responsible_for_control_user_id })
                        });
                        alert('Production order updated successfully');
                        document.getElementById('edit-order-modal').style.display = 'none';
                        loadProductionOrders();
                    } catch (error) {
                        console.error("Error updating order:", error);
                    }
                }
                window.onload = () => {
                    loadUsers();
                    loadProducts();
                    loadProductsList();
                    loadProductionOrders();
                    loadControlUsers();
                    loadUserOrders();
                    loadQualityControlOrders();
                    loadPerformance();
                    loadMaterials();
                    loadPurchaseRequests();
                    loadMaterialsIntoDropdown('purchase-material-list');
                    loadSuppliers();
                    loadSupplierList('purchase-supplier-list'); 
                    loadSupplierList('edit-purchase-supplier-list');
                    loadActivePurchaseRequests();
                    loadControlUsersForSuppliers('supplier-control-user-list');
                    loadPurchaseHistory();
                    loadWarehouseInventory();
                    loadSuppliersMaterials();
                    loadEmployeeTable();
                    loadRoles();
                    loadRolesSearch();
                    loadRolesTable();
                    loadNewRoleResponsibilities();
                    loadFinishedGoodsInventory();
                };
            </script>
            <style>
                .low-stock {
                    background-color: #ffe5e5;
                }
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                }
                .material-entry {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 5px;
                }
                button {
                    cursor: pointer;
                }
                #edit-budget-item-modal,
                #edit-material-modal,
                #edit-sales-modal,
                #edit-client-modal,
                #edit-campaign-modal,
                #edit-supplier-modal,
                #edit-employee-modal,
                #edit-competitor-modal,
                #edit-role-modal,
                #edit-purchase-modal,
                #edit-product-modal,
                #edit-order-modal {
                    display: none;
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background-color: white;
                    padding: 20px;
                    border: 1px solid black;
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                    width: 90%;
                    max-width: 600px;
                    max-height: 80vh;
                    overflow-y: auto;
                    border-radius: 8px;
                }
                #edit-budget-item-modal input[type="text"],
                #edit-budget-item-modal input[type="number"],
                #edit-budget-item-modal select,
                #edit-material-modal input[type="number"],
                #edit-sales-modal select,
                #edit-sales-modal input[type="number"],
                #edit-client-modal input[type="text"],
                #edit-client-modal input[type="email"],
                #edit-client-modal input[type="tel"],
                #edit-campaign-modal input[type="text"],
                #edit-campaign-modal input[type="number"],
                #edit-campaign-modal select,
                #edit-competitor-modal input[type="text"],
                #edit-competitor-modal input[type="url"],
                #edit-competitor-modal select,
                #edit-role-modal input[type="text"],
                #edit-employee-modal input[type="text"],
                #edit-employee-modal input[type="password"],
                #edit-employee-modal input[type="email"],
                #edit-employee-modal select,
                #edit-employee-modal textarea,
                #edit-supplier-modal input,
                #edit-supplier-modal select,
                #edit-purchase-modal select,
                #edit-purchase-modal input,
                #edit-product-modal input[id="edit-product-name"],
                #edit-order-modal select,
                #edit-order-modal input[type="number"]{
                    width: 100%;
                    padding: 10px;
                    margin-bottom: 10px;
                    border: 1px solid #ccc;
                    border-radius: 4px;
                    box-sizing: border-box;
                }
                label {
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            ${functionalities}
        </body>
        </html>
    `);
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});