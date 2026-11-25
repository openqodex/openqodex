const express = require('express');
const router = express.Router();
function getUser(req, res) { res.json({ id: req.params.id }); }
router.get('/:id', getUser);
module.exports = router;
