import {port} from 'config';
import express from 'express';
import Router from 'express-promise-router';
import route from './routes';
import {log} from './utils/logger';

const app = express();
const router = Router();

app.use(router);
route(app, router);

app.listen(port, () => {
    log.info(`Server is listening on port ${port}`);
});
