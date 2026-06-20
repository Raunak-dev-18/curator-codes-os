import clientPromise from '../mongodb';
import { UIMessage } from 'ai';

export interface Project {
  _id: string; // The project ID (uuid)
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  messages: UIMessage[];
  files?: { path: string; content: string; updatedAt: Date }[];
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
    messages: [],
    files: []
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

// --- FILE SYNC HELPERS ---

export async function getProjectFiles(projectId: string) {
  const collection = await getCollection();
  const project = await collection.findOne({ _id: projectId }, { projection: { files: 1 } });
  return project?.files || [];
}

export async function saveProjectFile(projectId: string, path: string, content: string) {
  const collection = await getCollection();
  
  // Clean path (remove leading ./)
  const cleanPath = path.startsWith('./') ? path.slice(2) : path;

  // Check if file exists
  const project = await collection.findOne({ _id: projectId, 'files.path': cleanPath });
  
  if (project) {
    // Update existing file
    return collection.updateOne(
      { _id: projectId, 'files.path': cleanPath },
      { $set: { 'files.$.content': content, 'files.$.updatedAt': new Date() } }
    );
  } else {
    // Add new file
    return collection.updateOne(
      { _id: projectId },
      { $push: { files: { path: cleanPath, content, updatedAt: new Date() } } as any }
    );
  }
}

export async function deleteProjectFile(projectId: string, path: string) {
  const collection = await getCollection();
  const cleanPath = path.startsWith('./') ? path.slice(2) : path;
  
  return collection.updateOne(
    { _id: projectId },
    { $pull: { files: { path: cleanPath } } as any }
  );
}

export async function renameProjectFile(projectId: string, oldPath: string, newPath: string) {
  const collection = await getCollection();
  const cleanOld = oldPath.startsWith('./') ? oldPath.slice(2) : oldPath;
  const cleanNew = newPath.startsWith('./') ? newPath.slice(2) : newPath;

  return collection.updateOne(
    { _id: projectId, 'files.path': cleanOld },
    { $set: { 'files.$.path': cleanNew, 'files.$.updatedAt': new Date() } }
  );
}
