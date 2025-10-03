import { useState, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { mergeMP4, checkFormatCompatibility } from './mergeMP4';
import './App.css';

interface SortableItemProps {
  id: string;
  file: File;
  index: number;
}

function SortableItem({ id, file, index }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className="file-item">
      <div {...attributes} {...listeners} className="drag-handle">⋮⋮</div>
      <span>{index + 1}. {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
    </div>
  );
}

function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [mergedBlob, setMergedBlob] = useState<Blob | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    const mp4Files = selectedFiles.filter(file => file.type === 'video/mp4');
    if (mp4Files.length !== selectedFiles.length) {
      setError('Only MP4 files are supported');
    } else {
      setError('');
      setFiles(mp4Files);
      setMergedBlob(null);
      setWarnings([]);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setFiles((items) => {
        const oldIndex = items.findIndex(item => item.name === active.id);
        const newIndex = items.findIndex(item => item.name === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleMerge = async () => {
    if (files.length < 2) {
      setError('Select at least 2 files to merge');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const compatibilityWarnings = await checkFormatCompatibility(files);
      setWarnings(compatibilityWarnings);
      if (compatibilityWarnings.length > 0) {
        // Still proceed, but warn
      }
      const blob = await mergeMP4(files);
      setMergedBlob(blob);
      setCurrentFileIndex(0); // Start with first file
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current && files.length > 0) {
      const currentTime = videoRef.current.currentTime;
      const totalDuration = videoRef.current.duration;
      if (totalDuration > 0) {
        const progress = currentTime / totalDuration;
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const currentSizePos = progress * totalSize;
        let cumulativeSize = 0;
        for (let i = 0; i < files.length; i++) {
          cumulativeSize += files[i].size;
          if (currentSizePos < cumulativeSize) {
            setCurrentFileIndex(i);
            break;
          }
        }
      }
    }
  };

  const handleDownload = () => {
    if (mergedBlob) {
      const url = URL.createObjectURL(mergedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merged.mp4';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="app">
      <h1>MP4 Fragment Merger</h1>
      
      <div className="file-picker">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".mp4"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <button onClick={() => fileInputRef.current?.click()}>
          Add MP4 Files
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {files.length > 0 && (
        <div className="file-list">
          <h2>Files to Merge (drag to reorder)</h2>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={files.map(f => f.name)} strategy={verticalListSortingStrategy}>
              {files.map((file, index) => (
                <SortableItem key={file.name} id={file.name} file={file} index={index} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {files.length > 1 && (
        <button onClick={handleMerge} disabled={loading} className="merge-btn">
          {loading ? 'Merging...' : 'Merge Videos'}
        </button>
      )}

      {warnings.length > 0 && (
        <div className="warnings">
          <h3>Warnings:</h3>
          <ul>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {mergedBlob && (
        <div className="preview">
          <h2>
            Merged Video
            {currentFileIndex >= 0 && files[currentFileIndex] && (
              <span> - Playing: {files[currentFileIndex].name}</span>
            )}
          </h2>
          <video ref={videoRef} controls onTimeUpdate={handleTimeUpdate}>
            <source src={URL.createObjectURL(mergedBlob)} type="video/mp4" />
          </video>
          <button onClick={handleDownload}>Download Merged MP4</button>
        </div>
      )}
    </div>
  );
}

export default App;