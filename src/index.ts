import {port} from 'config';
import express from 'express';
import Router from 'express-promise-router';
import route from './routes'
import {initDb} from "./db";
import {defaultNodeChecker, populateNodes, worker} from "./nodeSelector";

const app = express();
const router = Router();

app.use(router);
route(app, router);

const start = async () => {
  await initDb();
  await populateNodes();
  worker()
  defaultNodeChecker()
  app.listen(port, () => {
    console.log(`%c Server is listening on port ${port}`, 'color: green')
  });
}

start()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
