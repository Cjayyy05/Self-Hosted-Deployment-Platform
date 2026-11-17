import { Router } from 'express';

import { getAuthFeatures, login, me, register } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';

export const authRouter = Router();

authRouter.get('/features', getAuthFeatures);
authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.get('/me', authenticate, me);

