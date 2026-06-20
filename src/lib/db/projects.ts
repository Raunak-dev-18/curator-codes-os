import clientPromise from '../mongodb';
import { UIMessage } from 'ai';

export interface Project {
  _id: string; // The project ID (uuid)
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  messages: UIMessage[];
}

async function getCollection() {
  const client = await clientPromise;
  // Use a database name specified in env, or default to 'ai_builder'
  const db = client.db(process.env.MONGODB_DB_NAME || 'ai_builder');
  return db.collection<Project>('projects');
}

export async function createProject(userId: string, projectId: string, name: string) {
  const collection = await getCollection();
  const newProject: Project = {
    _id: projectId,
    userId,
    name,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: []
  };
  await collection.insertOne(newProject);
  return newProject;
}

export async function getUserProjects(userId: string) {
  const collection = await getCollection();
  // Return recent projects first, projecting only minimal info to keep payload small
  return collection.find({ userId })
    .project({ _id: 1, name: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function getProject(projectId: string, userId: string) {
  const collection = await getCollection();
  return collection.findOne({ _id: projectId, userId });
}

export async function saveMessages(projectId: string, userId: string, messages: UIMessage[]) {
  const collection = await getCollection();
  return collection.updateOne(
    { _id: projectId, userId },
    { 
      $set: { 
        messages,
        updatedAt: new Date()
      } 
    }
  );
}
