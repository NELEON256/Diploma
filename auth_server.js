const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const app = express();
const PORT = 3001;
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'company_data',
    password: 'kolokol2',
    port: 5432
});
const STANDARD_PASSWORD = '12345678';
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(express.json());
app.get('/', (req, res) => {
    const { error } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="/css/login.css">
            <title>Login</title>
        </head>
        <body>
            ${error ? `<p style="color: red;">${error}</p>` : ''}
            <div class="login-page">
                <div class="form">
                    <div class="form-title">Login</div>
                    <form class="login-form" action="/login" method="POST">
                        <label for="email">Email:</label>
                        <input type="text" id="email" name="email" required>
                        <label for="password">Password:</label>
                        <input type="password" id="password" name="password" required>
                        <button type="submit">Login</button>
                    </form>
                </div>
            </div>
        </body>
        </html>
    `);
});
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query(`
            SELECT u.id, u.password, r.responsibilities 
            FROM users u
            JOIN roles r ON u.role = r.role_name
            WHERE u.email = $1
        `, [email]);
        if (result.rows.length === 0) {
            return res.redirect('/?error=User not found');
        }
        const user = result.rows[0];
        if (password === user.password) {
            if (password === STANDARD_PASSWORD) {
                res.redirect(`/reset-password?email=${email}`);
            } else {
                const responsibilities = typeof user.responsibilities === "string"
                    ? JSON.parse(user.responsibilities)
                    : user.responsibilities;
                res.redirect(`http://localhost:3003/dashboard?user_id=${user.id}&responsibilities=${encodeURIComponent(JSON.stringify(responsibilities))}`);
            }
        } else {
            return res.redirect('/?error=Invalid password');
        }
    } catch (error) {
        console.error('Error occurred:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.get('/reset-password', (req, res) => {
    const { email, error } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="/css/login.css">
            <title>Reset Password</title>
        </head>
        <body>
            ${error ? `<p style="color: red;">${error}</p>` : ''}
            <div class="login-page">
                <div class="form">
                    <div class="form-title">Reset Password</div>
                        <form action="/update-password" method="POST">
                            <input type="hidden" name="email" value="${email}">
                            <label for="newPassword">New Password (16-35 characters):</label>
                            <input type="password" id="newPassword" name="newPassword" required>
                            <label for="confirmPassword">Confirm Password:</label>
                            <input type="password" id="confirmPassword" name="confirmPassword" required>
                            <button type="submit">Update Password</button>
                        </form>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `);
});
app.post('/update-password', async (req, res) => {
    try {
        const { email, newPassword, confirmPassword } = req.body;
        if (newPassword.length < 16 || newPassword.length > 35) {
            return res.redirect(`/reset-password?email=${email}&error=Password must be between 16 and 35 characters`);
        }
        if (newPassword !== confirmPassword) {
            return res.redirect(`/reset-password?email=${email}&error=Passwords do not match`);
        }
        await pool.query('UPDATE users SET password = $1 WHERE email = $2', [newPassword, email]);
        res.send('Password updated successfully! You can now login with your new password.');

    } catch (error) {
        console.error('Error occurred:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.listen(PORT, () => {
    console.log(`Server(auth) is running on http://localhost:${PORT}`);
});