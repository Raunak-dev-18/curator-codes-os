import { getMongoClient } from '../mongodb';
import { normalizeProjectPath } from '../project-paths';
import { UIMessage } from 'ai';

export interface ProjectFile {
  path: string;
  content: string;
  updatedAt: Date;
}

export interface Project {
  _id: string; // The project ID (uuid)
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  messages: UIMessage[];
  files?: ProjectFile[];
}

async function getCollection() {
  const client = await getMongoClient();
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

export async function getProjectFiles(projectId: string, userId: string) {
  const collection = await getCollection();
  const project = await collection.findOne({ _id: projectId, userId }, { projection: { files: 1 } });
  return project?.files || [];
}

export async function saveProjectFile(projectId: string, userId: string, path: string, content: string) {
  const collection = await getCollection();
  const cleanPath = normalizeProjectPath(path);

  const updateResult = await collection.updateOne(
    { _id: projectId, userId, 'files.path': cleanPath },
    { $set: { 'files.$.content': content, 'files.$.updatedAt': new Date() } }
  );

  if (updateResult.matchedCount > 0) {
    return updateResult;
  }

  return collection.updateOne(
    { _id: projectId, userId, 'files.path': { $ne: cleanPath } },
    { $push: { files: { path: cleanPath, content, updatedAt: new Date() } } as any }
  );
}

export async function deleteProjectFile(projectId: string, userId: string, path: string) {
  const collection = await getCollection();
  const cleanPath = normalizeProjectPath(path);
  
  return collection.updateOne(
    { _id: projectId, userId },
    { $pull: { files: { path: cleanPath } } as any }
  );
}

export async function renameProjectFile(projectId: string, userId: string, oldPath: string, newPath: string) {
  const collection = await getCollection();
  const cleanOld = normalizeProjectPath(oldPath);
  const cleanNew = normalizeProjectPath(newPath);

  return collection.updateOne(
    { _id: projectId, userId, 'files.path': cleanOld },
    { $set: { 'files.$.path': cleanNew, 'files.$.updatedAt': new Date() } }
  );
}
