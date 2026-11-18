const express = require('express');
const router = express.Router();
function getUser(req, res) { res.json({}); }
router.get('/:id', getUser);
module.exports = router;
