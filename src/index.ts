import {port} from 'config';
import express from 'express';
import Router from 'express-promise-router';
import route from './routes'

const app = express();
const router = Router();

app.use(router);
route(app, router);

app.listen(port, err => {
  if(err) throw err;
  console.log(`%c Server is listening on port ${port}`, 'color: green')
});
