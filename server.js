const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure required directories exist for temp and output files
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// Environment configurations
const SECRET_KEY = process.env.SECRET_KEY || 'szaK3yb0y';
const PORT = process.env.PORT || 3000;

// Serve the frontend
app.use(express.static('public'));

const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 4 * 1024 * 1024 * 1024,
        files: 10
    }
});

const requireSecretKey = (req, res, next) => {
    // Check headers instead of the body
    const providedKey = req.headers['x-secret-key'];
    console.log(providedKey);

    if (providedKey !== SECRET_KEY) {
        // Reject the request instantly, closing the connection 
        // BEFORE any files are downloaded to disk
        console.log("Invalid secret key.");
        res.status(403).json({ error: 'Invalid secret key' });

        setTimeout(() => {
            if (!req.socket.destroyed) {
                req.socket.destroy();
            }
        }, 50)

        return;
    }

    next();
};

async function startServer() {
    // Dynamically import `p-limit` because version 7.3.0 is ESM-only
    const { default: pLimit } = await import('p-limit');
    // Enforce maximum 4 concurrent FFmpeg instances
    const limit = pLimit(4);

    const validCodecs = ['libsvtav1', 'libx265'];
    const validAudioCodecs = ['aac', 'libopus'];

    app.post('/upload', requireSecretKey, upload.array('videos'), (req, res) => {
        let { codec, preset, crf, audioCodec } = req.body;
        console.log("passed through")

        // Helper to cleanup partially uploaded files if validation fails
        const cleanupUploads = () => {
            if (req.files) {
                req.files.forEach(f => fs.unlink(f.path, () => { }));
            }
        };

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        // Validate strictly to prevent injection
        if (!validCodecs.includes(codec) || !validAudioCodecs.includes(audioCodec)) {
            cleanupUploads();
            return res.status(400).json({ error: 'Invalid codec selection' });
        }

        crf = parseInt(crf, 10);
        if (isNaN(crf) || crf < 0 || crf > 63) {
            cleanupUploads();
            return res.status(400).json({ error: 'Invalid CRF value' });
        }

        // Sanitize preset (only allow alphanumeric characters)
        preset = String(preset).replace(/[^a-zA-Z0-9]/g, '');

        req.files.forEach(file => {
            const jobId = crypto.randomUUID();
            const originalName = file.originalname;

            // Broadcast that a job was queued
            io.emit('job:queued', { jobId, originalName });

            // Add the video processing task to the concurrency limiter queue
            limit(() => processVideo({
                jobId,
                file,
                originalName,
                codec,
                preset,
                crf,
                audioCodec
            }));
        });

        res.json({ message: 'Files queued successfully' });
    });

    function processVideo({ jobId, file, originalName, codec, preset, crf, audioCodec }) {
        return new Promise((resolve) => {
            // Broadcast that this job is now starting
            io.emit('job:start', { jobId, originalName });

            // Using MKV output container for excellent broad codec compatibility
            const ext = '.mkv';
            const outputFilename = `${jobId}${ext}`;
            const outputPath = path.join(OUTPUTS_DIR, outputFilename);

            const options = [
                `-preset ${preset}`,
                `-crf ${crf}`
            ];

            // 2. Add codec-specific thread limiters
            // This assumes you want to limit each concurrent encode to 4 logical processors
            if (codec === 'libsvtav1') {
                options.push('-svtav1-params lp=4');
            } else if (codec === 'libx265') {
                options.push('-x265-params pools=4'); // pools=4 limits x265 to 4 threads
            }

            ffmpeg(file.path)
                .videoCodec(codec)
                .audioCodec(audioCodec)
                .outputOptions(options)
                .output(outputPath)
                .on('progress', (progress) => {
                    let percent = 0;
                    if (progress.percent) {
                        percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
                    }
                    io.emit('job:progress', { jobId, percent });
                })
                .on('end', () => {
                    io.emit('job:done', { jobId, filename: outputFilename, originalName });

                    // Cleanup uploaded original file
                    fs.unlink(file.path, () => { });

                    // Clean up the output file after expiration time (e.g., 1 hour)
                    setTimeout(() => {
                        fs.unlink(outputPath, (err) => {
                            if (!err) {
                                io.emit('job:expired', { jobId, filename: outputFilename });
                            }
                        });
                    }, 30 * 60 * 1000);

                    resolve();
                })
                .on('error', (err) => {
                    console.error(`[Job Error] ${jobId}:`, err);
                    io.emit('job:error', { jobId, error: err.message });

                    // Cleanup uploaded file on error
                    fs.unlink(file.path, () => { });
                    resolve(); // Always resolve the promise so the queue isn't blocked
                })
                .run();
        });
    }

    app.get('/download/:filename', (req, res) => {
        const filename = req.params.filename;

        // Prevent directory traversal
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            return res.status(400).send('Invalid filename');
        }

        const filepath = path.join(OUTPUTS_DIR, filename);
        if (fs.existsSync(filepath)) {
            res.download(filepath);
        } else {
            res.status(404).send('File not found or expired');
        }
    });

    server.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`🔑 Secret key is: ${SECRET_KEY}`);
        console.log(`📂 Outputs will be temporarily saved in the 'outputs' directory`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});