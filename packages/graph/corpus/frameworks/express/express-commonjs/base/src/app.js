const express = require('express');
const users = require('./users');
const app = express();
app.use('/users', users);
app.use('/items', require('./items'));
module.exports = app;
