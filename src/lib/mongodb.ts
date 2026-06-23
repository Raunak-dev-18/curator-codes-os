import { MongoClient } from 'mongodb';

const options = {};

let clientPromise: Promise<MongoClient> | undefined;

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

export function getMongoClient() {
  if (process.env.NODE_ENV === 'development') {
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = createMongoClient();
    }

    return global._mongoClientPromise;
  }

  if (!clientPromise) {
    clientPromise = createMongoClient();
  }

  return clientPromise;
}

function createMongoClient() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('Invalid/Missing environment variable: "MONGODB_URI"');
  }

  return new MongoClient(uri, options).connect();
}
