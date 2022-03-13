import arweaveNodes from './arweaveNodes.json';
import getDb from '../db';
import axios from "axios";
import config from 'config';
import {delay} from "../utils";
import Arweave from "arweave";

const DEFAULT_NODE_HOST = config.get('arweave.default_node_host');
const DEFAULT_NODE_PORT = Number(config.get('arweave.default_node_port'));
const DEFAULT_NODE_PROTOCOL = config.get('arweave.default_node_protocol');
const ARWEAVE_TIMEOUT = Number(config.get('arweave.timeout'));
const WORKER_DELAY = Number(config.get('arweave.worker_delay'));
const DEFAULT_NODE_HEALTH_CHECK_INTERVAL = Number(
  config.get('arweave.default_node_health_check_interval')
);
const LOGGING = !!config.get('arweave.logging')

export const populateNodes = async () => {
  let nodes: string[];
  try {
    // For some reasons, arweave response can contain duplicates
    nodes = Array.from(
      new Set((
        await axios.get(`${DEFAULT_NODE_PROTOCOL}://${DEFAULT_NODE_HOST}:${DEFAULT_NODE_PORT}/peers`
        )).data)
    );
  } catch (e) {
    console.error('Failed to get arweave peers list: ');
    console.error(e);
    nodes = arweaveNodes;
  }
  if (nodes.length > 0) {
    console.log(`Populating ${nodes.length} arweave nodes into the db`)
    const query = `INSERT into arweave_nodes (host, port) values ${
      '(?, ?), '.repeat(nodes.length - 1)
    } (?, ?);`;
    const values = nodes.reduce(
      (acc: string[], cur: string) => [...acc, `${cur.split(':')[0]}`, `${cur.split(':')[1]}`],
      []
    );
    await getDb().run(query, values);
    console.log('Arweave nodes successfully populated')
  } else {
    // This is expected in e2e mode
    console.log('Populating nodes aborted: nodes list is empty')
  }
}

export const worker = async () => {
  try {
    while (true) {
      const allNodes = await getDb().all('SELECT * FROM arweave_nodes');
      for (const node of allNodes) {
        let nodeIsUp: boolean
        try {
          await axios.get(`http://${node.host}:${node.port}/info`);
          nodeIsUp = true
        } catch (e) {
          nodeIsUp = false
        }
        await getDb().run(
          'UPDATE arweave_nodes SET status = ? WHERE ROWID = ?',
          [nodeIsUp ? 'up' : 'down', node.rowid]
        );
        await delay(WORKER_DELAY);
      }
    }
  } catch (e) {
    console.error('Peer status worker failed');
    process.exit(1);
  }
}

let defaultNodeIsUp = true

const defaultArweaveClient = Arweave.init({
  host: DEFAULT_NODE_HOST,
  port: DEFAULT_NODE_PORT,
  protocol: DEFAULT_NODE_PROTOCOL,
  timeout: ARWEAVE_TIMEOUT,
  logging: LOGGING
});

export const getWorkingArweaveClient = async () => {
  if (defaultNodeIsUp) {
    return defaultArweaveClient
  } else {
    console.log('Default node is down, getting a reserve one')
    const workingArweaveNodes = await getDb()
      .all('SELECT * FROM arweave_nodes WHERE status = ?', 'up')
    if (workingArweaveNodes.length === 0) {
      throw new Error('No working arweave client');
    }
    const node = workingArweaveNodes[Math.round(Math.random() * (workingArweaveNodes.length - 1))]

    return Arweave.init({
      host: node.host,
      port: node.port,
      protocol: 'http',
      timeout: ARWEAVE_TIMEOUT,
      logging: LOGGING
    });
  }
}

export const defaultNodeChecker = async () => {
  try {
    while (true) {
      try {
        await defaultArweaveClient.network.getInfo()
        defaultNodeIsUp = true
      } catch (e) {
        console.error('Default node seems to be down: ')
        console.error(e.message)
        defaultNodeIsUp = false
      }
      await delay(DEFAULT_NODE_HEALTH_CHECK_INTERVAL)
    }
  } catch (e) {
    console.error('Default arweave node worker failed');
    process.exit(1);
  }
}
