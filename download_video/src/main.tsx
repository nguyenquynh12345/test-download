import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import FbReelDownloader from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FbReelDownloader />
  </StrictMode>,
)
