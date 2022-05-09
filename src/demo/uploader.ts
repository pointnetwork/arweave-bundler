// npx ts-node ./src/demo/uploader.ts filename

import FormData from 'form-data';
import axios from 'axios';
import {promises as fs} from 'fs';
import {hashFn} from '../utils/hashFn';

const log = console;
const filePath = process.argv[2];
const REQUEST_TIMEOUT = 100000;
const BUNDLER_URL = 'http://127.0.0.1:8080';

(async function () {
    const VERSION_MAJOR = 1;
    const VERSION_MINOR = 8;
    log.info({filePath});
    const data = await fs.readFile(filePath);
    const chunkId = hashFn(data).toString('hex');
    log.info({chunkId}, 'Starting chunk upload');
    const formData = new FormData();
    formData.append('file', data, chunkId);
    formData.append('__pn_integration_version_major', VERSION_MAJOR);
    formData.append('__pn_integration_version_minor', VERSION_MINOR);
    formData.append('__pn_chunk_id', chunkId);
    formData.append(`__pn_chunk_${VERSION_MAJOR}.${VERSION_MINOR}_id`, chunkId);
    const response = await axios.post(`${BUNDLER_URL}/signPOST`, formData, {
        headers: {
            ...formData.getHeaders(),
            chunkid: chunkId
        },
        timeout: REQUEST_TIMEOUT
    });
    log.info({response});
})();
