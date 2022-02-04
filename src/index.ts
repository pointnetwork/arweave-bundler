var express = require('express');
var app = express();
const Router = require('express-promise-router');
const router = Router();
app.use(router);

require('./routes')(app, router);

const port = process.env.PORT || 80;

app.listen(port, err => {
  if(err) throw err;
  console.log('%c Server running', 'color: green')
});
