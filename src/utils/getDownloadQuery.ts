import {gql} from 'graphql-request';
import config from 'config';

const getDownloadQuery = (chunkId: string, sort?: 'asc' | 'desc'): string =>
    gql`{
      transactions(
        ${sort && (sort === 'asc' ? 'HEIGHT_ASC' : 'HEIGHT_DESC')}
        tags: [
          {
            name: "__pn_chunk_${config.get(
        'storage.arweave_experiment_version_major'
    )}.${config.get('storage.arweave_experiment_version_minor')}_id",
            values: ["${chunkId}"]
          }
        ]
      ) {
        edges {
          node {
            id
          }
        }
      }
    }`;

export default getDownloadQuery;
