const express = require('express');
const router = express.Router();
function getItem(req, res) { res.json([]); }
router.get('/:id', getItem);
module.exports = router;
