// Modul untuk menambahkan nomor pelanggan ke tag GenieACS
const axios = require('axios');
require('dotenv').config();
const { logger } = require('./logger');

let sock = null;

// Fungsi untuk set instance sock
function setSock(sockInstance) {
    sock = sockInstance;
}

// Fungsi untuk menambahkan tag pelanggan ke perangkat GenieACS
async function addCustomerTag(remoteJid, params) {
    try {
        // Ekstrak parameter
        if (params.length < 2) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Formato incorrecto*\n\nFormato correcto:\naddtag [device_id] [numero_cliente]\n\nEjemplo:\naddtag 202BC1-BM632w-000000 0981123456`
            });
            return;
        }

        const [deviceId, customerNumber] = params;
        
        // Validasi nomor pelanggan
        if (!customerNumber || !/^\d{8,}$/.test(customerNumber)) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Número de cliente inválido*\n\nEl número de cliente debe tener al menos 8 dígitos.`
            });
            return;
        }
        
        // Dapatkan URL GenieACS
        const genieacsUrl = global.appSettings.genieacsUrl || process.env.GENIEACS_URL;
        if (!genieacsUrl) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Configuración incompleta*\n\nLa URL de GenieACS no está configurada`
            });
            return;
        }
        
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, {
            text: `⏳ *Agregando etiqueta*\n\nAgregando el número ${customerNumber} al equipo ${deviceId}...`
        });
        
        // Persiapkan URL untuk menambahkan tag
        const tagUrl = `${genieacsUrl}/devices/${deviceId}/tags/${customerNumber}`;
        
        // Kirim request ke GenieACS untuk menambahkan tag
        try {
            const response = await axios.post(
                tagUrl,
                {},
                {
                    auth: {
                        username: global.appSettings.genieacsUsername || process.env.GENIEACS_USERNAME,
                        password: global.appSettings.genieacsPassword || process.env.GENIEACS_PASSWORD
                    }
                }
            );
            
            logger.info(`Tag response: ${response.status}`);
            
            // Kirim pesan sukses
            let successMessage = `✅ *Etiqueta agregada*\n\n`;
            successMessage += `📱 *Número de cliente:* ${customerNumber}\n`;
            successMessage += `🖥️ *Device ID:* ${deviceId}\n\n`;
            successMessage += `El cliente ya puede usar WhatsApp y el portal web con ese número.`;
            
            await sock.sendMessage(remoteJid, { text: successMessage });
            
        } catch (error) {
            logger.error('Error adding tag to GenieACS:', error);
            
            let errorMessage = `❌ *No se pudo agregar la etiqueta*\n\n`;
            if (error.response) {
                errorMessage += `Status: ${error.response.status}\n`;
                errorMessage += `Mensaje: ${JSON.stringify(error.response.data)}\n`;
            } else {
                errorMessage += `Error: ${error.message}\n`;
            }
            
            await sock.sendMessage(remoteJid, { text: errorMessage });
        }
        
    } catch (error) {
        logger.error('Error in addCustomerTag:', error);
        
        await sock.sendMessage(remoteJid, {
            text: `❌ *Error*\n\nTerjadi kesalahan saat menambahkan tag: ${error.message}`
        });
    }
}

// Fungsi untuk mencari perangkat berdasarkan ID
async function findDeviceById(deviceId) {
    try {
        // Dapatkan URL GenieACS
        const genieacsUrl = global.appSettings.genieacsUrl || process.env.GENIEACS_URL;
        if (!genieacsUrl) {
            logger.error('GenieACS URL not configured');
            return null;
        }
        
        // Buat query untuk mencari perangkat berdasarkan ID
        const queryObj = { "_id": deviceId };
        const queryJson = JSON.stringify(queryObj);
        const encodedQuery = encodeURIComponent(queryJson);
        
        // Ambil perangkat dari GenieACS
        const response = await axios.get(`${genieacsUrl}/devices/?query=${encodedQuery}`, {
            auth: {
                username: global.appSettings.genieacsUsername || process.env.GENIEACS_USERNAME,
                password: global.appSettings.genieacsPassword || process.env.GENIEACS_PASSWORD
            },
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (response.data && response.data.length > 0) {
            return response.data[0];
        }
        
        return null;
    } catch (error) {
        logger.error(`Error finding device by ID: ${error.message}`);
        return null;
    }
}

// Fungsi untuk menambahkan tag berdasarkan PPPoE Username
async function addTagByPPPoE(remoteJid, params, sock) {
    try {
        // Ekstrak parameter
        if (params.length < 2) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Formato incorrecto*\n\nFormato correcto:\naddpppoe_tag [usuario_pppoe] [numero_cliente]\n\nEjemplo:\naddpppoe_tag user123 0981123456`
            });
            return;
        }

        const [pppoeUsername, customerNumber] = params;
        
        // Validasi nomor pelanggan
        if (!customerNumber || !/^\d{8,}$/.test(customerNumber)) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Número de cliente inválido*\n\nEl número de cliente debe tener al menos 8 dígitos.`
            });
            return;
        }
        
        // Dapatkan URL GenieACS
        const genieacsUrl = global.appSettings.genieacsUrl || process.env.GENIEACS_URL;
        if (!genieacsUrl) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Configuración incompleta*\n\nLa URL de GenieACS no está configurada`
            });
            return;
        }
        
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, {
            text: `⏳ *Buscando equipo*\n\nBuscando el equipo con usuario PPPoE ${pppoeUsername}...`
        });
        
        // Cari perangkat berdasarkan PPPoE Username
        const device = await findDeviceByPPPoE(pppoeUsername);
        
        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: `❌ *Equipo no encontrado*\n\nNo se encontró ningún equipo con usuario PPPoE ${pppoeUsername}`
            });
            return;
        }
        
        // Dapatkan device ID
        const deviceId = device._id;
        
        // Kirim pesan bahwa proses sedang berlangsung
        await sock.sendMessage(remoteJid, {
            text: `⏳ *Agregando etiqueta*\n\nAgregando el número ${customerNumber} al equipo ${deviceId}...`
        });
        
        // Persiapkan URL untuk menambahkan tag
        const tagUrl = `${genieacsUrl}/devices/${deviceId}/tags/${customerNumber}`;
        
        // Kirim request ke GenieACS untuk menambahkan tag
        try {
            const response = await axios.post(
                tagUrl,
                {},
                {
                    auth: {
                        username: global.appSettings.genieacsUsername || process.env.GENIEACS_USERNAME,
                        password: global.appSettings.genieacsPassword || process.env.GENIEACS_PASSWORD
                    }
                }
            );
            
            logger.info(`Tag response: ${response.status}`);
            
            // Kirim pesan sukses
            let successMessage = `✅ *Etiqueta agregada*\n\n`;
            successMessage += `📱 *Número de cliente:* ${customerNumber}\n`;
            successMessage += `👤 *PPPoE Username:* ${pppoeUsername}\n`;
            successMessage += `🖥️ *Device ID:* ${deviceId}\n\n`;
            successMessage += `El cliente ya puede usar WhatsApp y el portal web con ese número.`;
            
            await sock.sendMessage(remoteJid, { text: successMessage });
            
        } catch (error) {
            logger.error('Error adding tag to GenieACS:', error);
            
            let errorMessage = `❌ *No se pudo agregar la etiqueta*\n\n`;
            if (error.response) {
                errorMessage += `Status: ${error.response.status}\n`;
                errorMessage += `Mensaje: ${JSON.stringify(error.response.data)}\n`;
            } else {
                errorMessage += `Error: ${error.message}\n`;
            }
            
            await sock.sendMessage(remoteJid, { text: errorMessage });
        }
        
    } catch (error) {
        logger.error('Error in addTagByPPPoE:', error);
        
        await sock.sendMessage(remoteJid, {
            text: `❌ *Error*\n\nTerjadi kesalahan saat menambahkan tag: ${error.message}`
        });
    }
}

// Fungsi untuk mencari perangkat berdasarkan PPPoE Username
async function findDeviceByPPPoE(pppoeUsername) {
    try {
        // Dapatkan URL GenieACS
        const genieacsUrl = global.appSettings.genieacsUrl || process.env.GENIEACS_URL;
        if (!genieacsUrl) {
            logger.error('GenieACS URL not configured');
            return null;
        }
        
        // Parameter paths untuk PPPoE Username
        const pppUsernamePaths = [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value',
            'VirtualParameters.pppoeUsername',
            'VirtualParameters.pppUsername'
        ];
        
        // Buat query untuk mencari perangkat berdasarkan PPPoE Username
        // Kita perlu membuat query yang mencari di semua kemungkinan path
        const queryObj = { $or: [] };
        
        // Tambahkan semua kemungkinan path ke query
        for (const path of pppUsernamePaths) {
            const pathQuery = {};
            pathQuery[path] = pppoeUsername;
            queryObj.$or.push(pathQuery);
        }
        
        const queryJson = JSON.stringify(queryObj);
        const encodedQuery = encodeURIComponent(queryJson);
        
        // Ambil perangkat dari GenieACS
        const response = await axios.get(`${genieacsUrl}/devices/?query=${encodedQuery}`, {
            auth: {
                username: global.appSettings.genieacsUsername || process.env.GENIEACS_USERNAME,
                password: global.appSettings.genieacsPassword || process.env.GENIEACS_PASSWORD
            },
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (response.data && response.data.length > 0) {
            return response.data[0];
        }
        
        return null;
    } catch (error) {
        logger.error(`Error finding device by PPPoE Username: ${error.message}`);
        return null;
    }
}

module.exports = {
    setSock,
    addCustomerTag,
    findDeviceById,
    addTagByPPPoE
};
