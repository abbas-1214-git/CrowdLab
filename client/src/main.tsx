import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Overlay from './Overlay';
import './styles.css';
import './dashboard-extra.css';

const isOverlay = window.location.pathname.replace(/\/+$/, '') === '/overlay';
document.body.classList.toggle('overlay-body', isOverlay);

createRoot(document.getElementById('root')!).render(<React.StrictMode>{isOverlay ? <Overlay /> : <App />}</React.StrictMode>);
