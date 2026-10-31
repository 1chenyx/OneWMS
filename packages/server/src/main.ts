import { start } from './index.js';

// 进程入口（npm start / npm run dev）：与库入口分离，测试 import index 不会触发监听。
start();
