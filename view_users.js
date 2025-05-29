const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const app = express();
const PORT = 3002;
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'company_data',
    password: 'kolokol2',
    port: 5432
});
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
function escapeHTML(str) {
    return str.replace(/[&<>"']/g, function(match) {
        const escapeMap = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return escapeMap[match];
    });
}
app.get('/', async (req, res) => {
    try {
        const { first_name = '', last_name = '', role = '', email = '' } = req.query;
        const rolesResult = await pool.query('SELECT role_name FROM roles ORDER BY role_name ASC');
        const roles = ['All roles', 'No role', ...rolesResult.rows.filter(row => row.role_name !== 'No role').map(row => row.role_name)];
        const result = await pool.query(`SELECT * FROM users ORDER BY id ASC`);
        const resultRoles = await pool.query('SELECT * FROM roles ORDER BY role_name ASC');
        function escapeString(str) {
            return encodeURIComponent(str).replace(/'/g, '%27').replace(/"/g, '%22');
        }
        const responsibilitiesGrouped = Object.entries(ALL_RESPONSIBILITIES)
            .map(([department, responsibilities]) => `
                <fieldset style="border: 1px solid #ccc; padding: 10px; margin-bottom: 15px; border-radius: 5px;">
                    <legend style="font-weight: bold; font-size: 16px;">${escapeHTML(department)}</legend>
                    ${responsibilities.map(responsibility => `
                        <div style="margin-bottom: 5px;">
                            <input type="checkbox" name="responsibilities" value="${escapeHTML(responsibility)}">
                            <label>${escapeHTML(responsibility)}</label>
                        </div>
                    `).join('')}
                </fieldset>
            `)
            .join('');
        const tableRowsRoles = resultRoles.rows
            .filter(row => row.role_name !== 'No role')
            .map(
                (row) => `
            <tr>
                <td>${escapeHTML(row.role_name)}</td>
                <td>${(row.responsibilities && Array.isArray(row.responsibilities) ? row.responsibilities.join(', ') : '')}</td>
                <td>
                    <button onclick="openEditRoleModal(${row.id}, '${escapeHTML(row.role_name)}')">Edit</button>
                    <button onclick="deleteRole(${row.id})">Delete</button>
                </td>
            </tr>`
            )
            .join('');
        const tableRows = result.rows
            .map(
                (row) => `
            <tr>
                <td>${row.id}</td>
                <td>${row.first_name}</td>
                <td>${row.last_name}</td>
                <td>${row.role}</td>
                <td>${row.email}</td>
                <td>${escapeHTML(row.password)}</td>
                <td>
                    <button onclick="openEditModal(${row.id}, '${escapeString(row.first_name)}', '${escapeString(row.last_name)}', '${escapeString(row.email)}', '${escapeString(row.role)}', '${escapeString(row.password)}')">Edit</button>
                    <button onclick="deleteUser(${row.id})">Delete</button>
                </td>
            </tr>`
            )
            .join('');
        const primaryRole = 'No role';
        const sortedRoles = [primaryRole, ...roles.filter(r => r !== primaryRole)];
        const roleOptions = roles
            .map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`)
            .join('');
        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Users Table</title>
            <script>
                 async function addRole(event) {
                    event.preventDefault();
                    const roleName = document.getElementById('add-role-name').value;
                    const checkboxes = document.querySelectorAll('input[name="responsibilities"]:checked');
                    const responsibilities = Array.from(checkboxes).map(cb => cb.value);
                    if (responsibilities.length === 0) {
                        alert('Please select at least one responsibility');
                        return;
                    }
                    const response = await fetch('/roles/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role_name: roleName, responsibilities })
                    });
                    if (response.ok) {
                        alert('Role added successfully');
                        document.getElementById('add-role-form').reset();
                        location.reload();
                    } else {
                        const errorMessage = await response.text();
                        alert('Error: ' + errorMessage);
                    }
                }
                async function openEditRoleModal(id, roleName) {
                    document.getElementById('edit-role-id').value = id;
                    document.getElementById('edit-role-name').value = roleName;
                    const responsibilitiesResponse = await fetch('/all-responsibilities');
                    const allResponsibilities = await responsibilitiesResponse.json();
                    const roleResponse = await fetch('/roles/' + id);
                    const roleData = await roleResponse.json();
                    const roleResponsibilities = roleData.responsibilities || [];
                    const responsibilitiesContainer = document.getElementById('edit-responsibilities-list');
                    responsibilitiesContainer.innerHTML = '';
                    Object.entries(allResponsibilities).forEach(([department, responsibilities]) => {
                        const fieldset = document.createElement('fieldset');
                        fieldset.style.border = "1px solid #ccc";
                        fieldset.style.padding = "10px";
                        fieldset.style.marginBottom = "15px";
                        fieldset.style.borderRadius = "5px";
                        const legend = document.createElement('legend');
                        legend.style.fontWeight = "bold";
                        legend.style.fontSize = "16px";
                        legend.textContent = department;
                        fieldset.appendChild(legend);
                        responsibilities.forEach(resp => {
                            const checkbox = document.createElement('input');
                            checkbox.type = 'checkbox';
                            checkbox.name = 'responsibilities';
                            checkbox.value = resp;
                            if (roleResponsibilities.includes(resp)) {
                                checkbox.checked = true;
                            }
                            const label = document.createElement('label');
                            label.appendChild(checkbox);
                            label.appendChild(document.createTextNode(' ' + resp));
                            fieldset.appendChild(label);
                            fieldset.appendChild(document.createElement('br'));
                        });
                        responsibilitiesContainer.appendChild(fieldset);
                    });
                    document.getElementById('edit-role-modal').style.display = 'block';
                }
                async function saveRole() {
                    const id = document.getElementById('edit-role-id').value;
                    const roleName = document.getElementById('edit-role-name').value;
                    const checkboxes = document.querySelectorAll('#edit-responsibilities-list input[name="responsibilities"]:checked');
                    const responsibilities = Array.from(checkboxes).map(cb => cb.value);
                    if (responsibilities.length === 0) {
                        alert('Please select at least one responsibility');
                        return;
                    }
                    const response = await fetch('/roles/edit/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role_name: roleName, responsibilities })
                    });
                    if (response.ok) {
                        alert('Role updated successfully');
                        document.getElementById('edit-role-modal').style.display = 'none';
                        location.reload();
                        updateRoleTable();
                    } else {
                        const errorMessage = await response.text();
                        alert('Error: ' + errorMessage);
                    }
                }
                async function deleteRole(id) {
                    if (confirm("Are you sure you want to delete this role?")) {
                        await fetch('/roles/delete/' + id, { method: 'DELETE' });
                        location.reload();
                        updateRoleTable();
                    }
                }
                function closeRoleModal() {
                    document.getElementById('edit-role-modal').style.display = 'none';
                }
                async function updateRoleTable() {
                    const response = await fetch('/roles');
                    const tableBody = document.getElementById('role-table-body');
                    tableBody.innerHTML = await response.text();
                }
                async function updateTable() {
                    const params = new URLSearchParams({
                        first_name: document.getElementById('first_name').value,
                        last_name: document.getElementById('last_name').value,
                        role: document.getElementById('role').value,
                        email: document.getElementById('email').value
                    });
                    const response = await fetch('/filter?' + params);
                    const tableBody = document.getElementById('table-body');
                    tableBody.innerHTML = await response.text();
                }
                async function addUser(event) {
                    event.preventDefault();
                    const firstName = document.getElementById('add-first-name').value;
                    const lastName = document.getElementById('add-last-name').value;
                    const email = document.getElementById('add-email').value;
                    const role = document.getElementById('add-role').value;
                    const response = await fetch('/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ first_name: firstName, last_name: lastName, email, role })
                    });
                    if (response.ok) {
                        alert('User added successfully');
                        document.getElementById('add-user-form').reset();
                        updateTable();
                    } else {
                        const errorMessage = await response.text();
                        alert('Error: ' + errorMessage);
                    }
                }
                function openEditModal(id, firstName, lastName, email, role, password) {
                    firstName = decodeURIComponent(firstName);
                    lastName = decodeURIComponent(lastName);
                    email = decodeURIComponent(email);
                    role = decodeURIComponent(role);
                    password = decodeURIComponent(password);
                    document.getElementById('edit-id').value = id;
                    document.getElementById('edit-first-name').value = firstName;
                    document.getElementById('edit-last-name').value = lastName;
                    document.getElementById('edit-email').value = email;
                    document.getElementById('edit-role').value = role;
                    document.getElementById('edit-password').value = password;
                    document.getElementById('edit-modal').style.display = 'block';
                }
                function validatePassword(password) {
                    if (password.length < 16 || password.length > 35) {
                        const passwordField = document.getElementById('edit-password');
                        passwordField.style.borderColor = 'red';
                        const errorMessage = document.getElementById('password-error');
                        errorMessage.style.display = 'block';
                        return false;
                    } else {
                        document.getElementById('edit-password').style.borderColor = '';
                        document.getElementById('password-error').style.display = 'none';
                        return true;
                    }
                }
                async function saveUser() {
                    const password = document.getElementById('edit-password').value;
                    if (!validatePassword(password)) {
                        return;
                    }
                    const id = document.getElementById('edit-id').value;
                    const updatedData = ({
                        first_name: document.getElementById('edit-first-name').value,
                        last_name: document.getElementById('edit-last-name').value,
                        email: document.getElementById('edit-email').value,
                        role: document.getElementById('edit-role').value,
                        password: document.getElementById('edit-password').value
                    });
                    await fetch('/edit/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(updatedData)
                    });
                    closeModal();
                    updateTable();
                }
                async function deleteUser(id) {
                    if (confirm("Are you sure you want to delete this user?")) {
                        await fetch('/delete/' + id, { method: 'DELETE' });
                        updateTable();
                    }
                }
                function closeModal() {
                    document.getElementById('edit-modal').style.display = 'none';
                }
            </script>
            <style>
                #edit-modal,
                #edit-role-modal {
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
                #edit-responsibilities-list {
                    max-height: 50vh;
                    overflow-y: auto;
                    padding: 10px;
                    border: 1px solid #ccc;
                    background-color: #f9f9f9;
                }
                #edit-modal input[type="text"],
                #edit-modal input[type="password"],
                #edit-modal select,
                #edit-modal textarea,
                #edit-role-modal input[type="text"]{
                    width: 100%;
                    padding: 10px;
                    margin-bottom: 10px;
                    border: 1px solid #ccc;
                    border-radius: 4px;
                    box-sizing: border-box;
                }
                fieldset {
                    border: 1px solid #ccc;
                    padding: 10px;
                    margin-bottom: 15px;
                    border-radius: 5px;
                }
                legend {
                    font-weight: bold;
                    font-size: 16px;
                }
                label {
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <h2>Add New Role</h2> 
            <form id="add-role-form" onsubmit="addRole(event)">
                <label for="add-role-name">Role Name:</label>
                <input type="text" id="add-role-name" name="role_name" required>
                <h4>Select Responsibilities:</h4>
                <div id="add-responsibilities-list">
                    ${responsibilitiesGrouped}
                </div>
                <br>
                <button type="submit">Add Role</button>
            </form>
            <h2>Roles Table</h2>
            <table border="1">
                <thead>
                    <tr>
                        <th>Role Name</th>
                        <th>Responsibilities</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="role-table-body">
                    ${tableRowsRoles}
                </tbody>
            </table>
            <div id="edit-role-modal" style="display: none;">
                <h2>Edit Role</h2>
                <input type="hidden" id="edit-role-id">
                <label for="edit-role-name">Role Name:</label>
                <input type="text" id="edit-role-name"><br>
                <h4>Select Responsibilities:</h4>
                <div id="edit-responsibilities-list"></div>
                <button onclick="saveRole()">Save</button>
                <button onclick="closeRoleModal()">Cancel</button>
            </div>
            <h2>Add New User</h2>
            <form id="add-user-form" onsubmit="addUser(event)">
                <label for="add-first-name">First Name:</label>
                <input type="text" id="add-first-name" name="first_name" required>
                <label for="add-last-name">Last Name:</label>
                <input type="text" id="add-last-name" name="last_name" required>
                <label for="add-email">Email:</label>
                <input type="email" id="add-email" name="email" required>
                <label for="add-role">Role:</label>
                <select id="add-role" name="role">
                    ${sortedRoles.filter(r => r !== 'All roles').map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`).join('')}
                </select>
                <button type="submit">Add user</button>
            </form>
            <h2>Users Table</h2>
            <form oninput="updateTable(); return false;">
                <label for="first_name">First Name:</label>
                <input type="text" id="first_name" name="first_name" value="${first_name}">
                <label for="last_name">Last Name:</label>
                <input type="text" id="last_name" name="last_name" value="${last_name}">
                <label for="role">Role:</label>
                <select id="role" name="role">
                    ${roleOptions}
                </select>
                <label for="email">Email:</label>
                <input type="text" id="email" name="email" value="${email}">
            </form>
            <table border="1">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>First name</th>
                        <th>Last name</th>
                        <th>Role</th>
                        <th>Email</th>
                        <th>Password</th>
                        <th>Editor</th>
                    </tr>
                </thead>
                <tbody id="table-body">
                    ${tableRows}
                </tbody>
            </table>
            <div id="edit-modal">
                <h2>Edit User</h2>
                <input type="hidden" id="edit-id">
                <label for="edit-first-name">First Name: </label>
                <input type="text" id="edit-first-name"><br>
                <label for="edit-last-name">Last Name: </label>
                <input type="text" id="edit-last-name"><br>
                <label for="edit-email">Email: </label>
                <input type="text" id="edit-email"><br>
                <label for="edit-role">Role: </label>
                <select id="edit-role">
                    ${sortedRoles.filter(r => r !== 'All roles').map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`).join('')}
                </select><br>
                <label for="edit-password">Password: </label>
                <input type="text" id="edit-password"><br>
                <div id="password-error" style="color: red; display: none;">Password must be between 16 and 35 characters long.</div>
                <button onclick="saveUser()">Save</button>
                <button onclick="closeModal()">Cancel</button>
            </div>
        </body>
        </html>
        `;
        res.send(html);
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.get('/roles', async (req, res) => {
    try {
        const resultRoles = await pool.query('SELECT * FROM roles ORDER BY role_name ASC');
        const tableRowsRoles = resultRoles.rows
            .map(
                (row) => `
            <tr>
                <td>${escapeHTML(row.role_name)}</td>
                <td>
                    <button onclick="openEditRoleModal(${row.id}, '${escapeHTML(row.role_name)}')">Edit</button>
                    <button onclick="deleteRole(${row.id})">Delete</button>
                </td>
            </tr>`
            )
            .join('');
        res.send(tableRowsRoles);
    } catch (error) {
        console.error('Error fetching filtered users:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.post('/roles/add', async (req, res) => {
    try {
        const { role_name, responsibilities } = req.body;
        if (!role_name) {
            return res.status(400).send('Role name is required');
        }
        if (!responsibilities || responsibilities.length === 0) {
            return res.status(400).send('At least one responsibility is required');
        }
        const responsibilitiesJson = JSON.stringify(responsibilities);
        const roleCheck = await pool.query('SELECT * FROM roles WHERE role_name = $1', [role_name]);
        if (roleCheck.rows.length > 0) {
            return res.status(400).send('Role already exists');
        }
        await pool.query('INSERT INTO roles (role_name, responsibilities) VALUES ($1, $2::jsonb)', [role_name, responsibilitiesJson]);
        res.status(201).send('Role added successfully');
    } catch (error) {
        console.error('Error adding role:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.get('/roles/:id', async (req, res) => {
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
app.put('/roles/edit/:id', async (req, res) => {
    const { id } = req.params;
    const { role_name, responsibilities } = req.body;
    if (!role_name) {
        return res.status(400).send('Role name is required');
    }
    if (!responsibilities || responsibilities.length === 0) {
        return res.status(400).send('At least one responsibility is required');
    }
    try {
        const roleExists = await pool.query('SELECT * FROM roles WHERE id = $1', [id]);
        if (roleExists.rows.length === 0) {
            return res.status(404).send('Role not found');
        }
        const responsibilitiesJson = JSON.stringify(responsibilities);
        await pool.query(
            'UPDATE roles SET role_name = $1, responsibilities = $2::jsonb WHERE id = $3',
            [role_name, responsibilitiesJson, id]
        );
        await pool.query('UPDATE users SET role = $1 WHERE role = $2', [role_name, roleExists.rows[0].role_name]);
        res.send('Role updated successfully');
    } catch (error) {
        console.error('Error updating role:', error.message);
        res.status(500).send('Server error');
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
app.get('/responsibilities', (req, res) => {
    res.json(Object.values(ALL_RESPONSIBILITIES).flat());
});
app.get('/all-responsibilities', (req, res) => {
    res.json(ALL_RESPONSIBILITIES);
});
app.delete('/roles/delete/:id', async (req, res) => {
    const { id } = req.params;
    const defaultRole = 'No role';
    try {
        const roleResult = await pool.query('SELECT role_name FROM roles WHERE id = $1', [id]);
        if (roleResult.rowCount === 0) {
            return res.status(404).send('Role not found');
        }
        const roleName = roleResult.rows[0].role_name;
        let checkDefaultRole = await pool.query('SELECT id FROM roles WHERE role_name = $1', [defaultRole]);
        if (checkDefaultRole.rowCount === 0) {
            await pool.query('INSERT INTO roles (role_name) VALUES ($1)', [defaultRole]);
        }
        await pool.query('UPDATE users SET role = $1 WHERE role = $2', [defaultRole, roleName]);
        await pool.query('DELETE FROM roles WHERE id = $1', [id]);
        res.send('Role deleted and users updated');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting role');
    }
});
app.post('/add', async (req, res) => {
    try {
        const { first_name, last_name, email, role } = req.body;
        if (!first_name || !last_name || !email || !role) {
            return res.status(400).send('All fields are required.');
        }
        const roleCheck = await pool.query('SELECT * FROM roles WHERE role_name = $1', [role]);
        if (roleCheck.rows.length === 0) {
            return res.status(400).send('Invalid role selected.');
        }
        const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).send('Email already exists.');
        }
        const defaultPassword = '12345678';
        await pool.query(
            'INSERT INTO users (first_name, last_name, email, role, password) VALUES ($1, $2, $3, $4, $5)',
            [first_name, last_name, email, role, defaultPassword]
        );
        res.status(201).send('User added successfully');
    } catch (error) {
        console.error('Error adding user:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.put('/edit/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { first_name, last_name, email, role, password } = req.body;
        if (password.length < 16 || password.length > 35) {
            return res.status(400).send('Password must be between 16 and 35 characters long');
        }
        await pool.query(
            'UPDATE users SET first_name = $1, last_name = $2, email = $3, role = $4, password = $5 WHERE id = $6',
            [first_name, last_name, email, role, password, id]
        );
        res.status(200).send('User updated successfully');
    } catch (error) {
        console.error('Error editing user:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.delete('/delete/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.status(200).send('User deleted successfully');
    } catch (error) {
        console.error('Error deleting user:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.get('/filter', async (req, res) => {
    try {
        const { first_name = '', last_name = '', role = '', email = '' } = req.query;
        const roleFilter = role && role !== 'All roles' ? `%${role}%` : '%';
        const result = await pool.query(
            `SELECT * FROM users 
            WHERE 
                first_name ILIKE $1 AND 
                last_name ILIKE $2 AND 
                role ILIKE $3 AND 
                email ILIKE $4
            ORDER BY id ASC`,
            [`%${first_name}%`, `%${last_name}%`, roleFilter, `%${email}%`]
        );
        function escapeString(str) {
            return encodeURIComponent(str).replace(/'/g, '%27').replace(/"/g, '%22'); // Додатково екранує лапки
        }
        const tableRows = result.rows
            .map(
                (row) => `
            <tr>
                <td>${row.id}</td>
                <td>${row.first_name}</td>
                <td>${row.last_name}</td>
                <td>${row.role}</td>
                <td>${row.email}</td>
                <td>${escapeHTML(row.password)}</td>
                <td>
                    <button onclick="openEditModal(${row.id}, '${escapeString(row.first_name)}', '${escapeString(row.last_name)}', '${escapeString(row.email)}', '${escapeString(row.role)}', '${escapeString(row.password)}')">Edit</button>
                    <button onclick="deleteUser(${row.id})">Delete</button>
                </td>
            </tr>`
            )
            .join('');
        res.send(tableRows);
    } catch (error) {
        console.error('Error fetching filtered users:', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.listen(PORT, () => {
    console.log(`Server(users) is running on http://localhost:${PORT}`);
});