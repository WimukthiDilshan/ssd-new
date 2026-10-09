const mysql = require('mysql2');

// Each transaction owns its connection; concurrent HTTP requests cannot share it.
module.exports = function paymentConnection(db) {
    const { host, port, user, password, database } = db.config;
    return mysql.createConnection({ host, port, user, password, database });
};
