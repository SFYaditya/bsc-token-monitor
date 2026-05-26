import express from 'express';
import cors from 'cors';
import { createRouter } from './routes/index.js';

export function createApp(): express.Application {
  const app = express();
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(',') ?? true,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use('/api/v1', createRouter());
  return app;
}
