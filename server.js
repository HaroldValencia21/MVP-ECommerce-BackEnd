// ============================================================
//  Ecommerce backend — Checkout seguro con Mercado Pago
//  Stack: Node.js + Express + Firebase Admin + Mercado Pago SDK v3
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// ---------- 1. Firebase Admin ----------
let firebaseApp;

if (process.env.FIREBASE_CREDENTIALS_JSON) {
  let serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);

  // Corregir los saltos de línea de la llave privada si se aplanaron en el pegado
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  firebaseApp = initializeApp({
    credential: cert(serviceAccount),
  });
} else {
  firebaseApp = initializeApp({
    credential: cert(path.join(__dirname, 'firebase-key.json')),
  });
}

const db = getFirestore(firebaseApp, 'default');

// ---------- 2. Mercado Pago ----------
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mercadopagoClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

const preferenceClient = new Preference(mercadopagoClient);
// Cliente de la API de Pagos: usado por el webhook para consultar el estado
// REAL de un pago en Mercado Pago ante cada notificación (IPN).
const paymentClient = new Payment(mercadopagoClient);
const nodemailer = require('nodemailer');

// Configura tu transporte (ejemplo usando un correo de Gmail o SMTP)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // Tu correo de la tienda
    pass: process.env.EMAIL_PASS  // Contraseña de aplicación de tu correo
  }
});

async function enviarCorreoComprobante(cliente, itemsSeguros, totalAmount, orderId) {
  const htmlItems = itemsSeguros.map(i => `<li>${i.title} - Cantidad: ${i.quantity} - $${i.unit_price * i.quantity} COP</li>`).join('');

  const mailOptions = {
    from: '"Tu Tienda White-Label" <tu-correo@gmail.com>',
    to: cliente.email,
    subject: `¡Comprobante de Compra! - Orden #${orderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
        <h2 style="color: #2563eb; text-align: center;">¡Gracias por tu compra, ${cliente.nombre}!</h2>
        <p>Tu pago ha sido procesado con éxito. Aquí tienes el resumen de tu pedido:</p>

        <div style="background-color: #f9fafb; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>ID de Orden:</strong> ${orderId}</p>
          <p><strong>Método de Envío:</strong> ${cliente.metodoEnvio}</p>
          <p><strong>Dirección de Destino:</strong> ${cliente.direccion}</p>
        </div>

        <h3>Productos:</h3>
        <ul>${htmlItems}</ul>

        <h3 style="text-align: right; color: #16a34a;">Total Pagado: $${totalAmount.toLocaleString()} COP</h3>

        <hr style="border: none; border-top: 1px solid #eaeaea; margin: 20px 0;" />
        <p style="font-size: 12px; color: #666; text-align: center;">Este es un correo automático de tu tienda de confianza. ¡Guarda este comprobante!</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}
// ---------- 3. Servidor Express ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- 4. Lógica de validación de precios ----------
// Extrae el precio REAL de un documento de producto.
function extraerPrecioReal(datosProducto, variante) {
  const inventario = datosProducto.inventario || {};

  if (inventario.tieneVariantes && Array.isArray(inventario.variantes)) {
    const varianteEncontrada = inventario.variantes.find(
      (v) =>
        String(v.atributo || '').trim().toLowerCase() ===
          String(variante || '').trim().toLowerCase() ||
        String(v.sku || '').trim().toLowerCase() ===
          String(variante || '').trim().toLowerCase(),
    );

    if (!varianteEncontrada) {
      throw new Error(`Variante "${variante}" no existe para este producto`);
    }
    return varianteEncontrada.precio;
  }

  const precioGlobal = datosProducto.precio && datosProducto.precio.actual;
  return precioGlobal;
}

// Recorre los items, verifica cada producto en Firestore
async function validarYCalcularItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('El carrito está vacío');
    error.status = 400;
    throw error;
  }

  const itemsSeguros = [];
  let totalAmount = 0;

  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      const error = new Error('ID de producto inválido');
      error.status = 400;
      throw error;
    }

    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      const error = new Error(`Cantidad inválida para el producto ${item.id}`);
      error.status = 400;
      throw error;
    }

    const doc = await db.collection('productos').doc(item.id.trim()).get();

    if (!doc.exists) {
      const error = new Error(`Producto ${item.id} no encontrado`);
      error.status = 404;
      throw error;
    }

    const datosProducto = doc.data();
    const precioReal = extraerPrecioReal(datosProducto, item.variante);

    if (typeof precioReal !== 'number' || precioReal <= 0) {
      const error = new Error(`El producto ${item.id} no tiene un precio válido`);
      error.status = 400;
      throw error;
    }

    const nombre =
      (datosProducto.informacion && datosProducto.informacion.nombre) || 'Producto';
    const titulo = item.variante ? `${nombre} - ${item.variante}` : nombre;

    totalAmount += precioReal * item.cantidad;

    itemsSeguros.push({
      id: `${item.id.trim()}-${item.variante || 'sin-variante'}`,
      title: titulo,
      unit_price: precioReal,
      quantity: item.cantidad,
      currency_id: 'COP',
    });
  }

  return { itemsSeguros, totalAmount };
}

// ---------- 5. Guardado de la orden en Firestore ----------
function validarCliente(cliente) {
  if (!cliente || typeof cliente !== 'object') {
    const error = new Error('Datos del cliente inválidos');
    error.status = 400;
    throw error;
  }

  const campos = ['nombre', 'email', 'telefono', 'direccion', 'metodoEnvio'];
  for (const campo of campos) {
    if (typeof cliente[campo] !== 'string' || cliente[campo].trim() === '') {
      const error = new Error(`El campo "${campo}" del cliente es obligatorio`);
      error.status = 400;
      throw error;
    }
  }

  return {
    nombre: cliente.nombre.trim(),
    email: cliente.email.trim(),
    telefono: cliente.telefono.trim(),
    direccion: cliente.direccion.trim(),
    metodoEnvio: cliente.metodoEnvio.trim(),
  };
}

async function guardarOrden(clienteValidado, itemsSeguros, totalAmount) {
  const ordenRef = await db.collection('ordenes').add({
    cliente: clienteValidado,
    items: itemsSeguros,
    total: totalAmount,
    estado: 'Pendiente',
    fechaCreacion: FieldValue.serverTimestamp(),
  });

  return ordenRef.id;
}

// ---------- 6. Creación de la Preference ----------

// Mercado Pago SOLO acepta auto_return cuando back_urls.success es una URL
// pública alcanzable por HTTPS. Si usamos localhost (desarrollo), la API
// responde "auto_return invalid. back_url.success must be defined" aunque
// el campo sí exista, porque no puede validar la URL. Por eso detectamos
// si la URL base es pública antes de activar auto_return.
function esUrlPublicaHttps(url) {
  try {
    const parsed = new URL(url);
    const esLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname.endsWith('.local');
    return parsed.protocol === 'https:' && !esLocal;
  } catch {
    return false;
  }
}

async function crearPreferencia(itemsSeguros, totalAmount, orderId, cliente) {
  const notificationUrl = process.env.MP_NOTIFICATION_URL;

  // Usa APP_BASE_URL si está definida en .env (recomendado: tu dominio con
  // HTTPS, o una URL de ngrok/túnel mientras desarrollas). Si no existe,
  // cae a localhost solo como referencia visual (no se usará auto_return).
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

  const back_urls = {
    success: `${baseUrl}/success?orderId=${orderId}`,
    pending: `${baseUrl}/pending?orderId=${orderId}`,
    failure: `${baseUrl}/failure`,
  };

  const puedeUsarAutoReturn = esUrlPublicaHttps(back_urls.success);

  if (!puedeUsarAutoReturn) {
    console.warn(
      '⚠️  APP_BASE_URL no es una URL pública HTTPS (o no está definida). ' +
      'Se omitirá "auto_return" para evitar el error de Mercado Pago. ' +
      'El usuario deberá volver manualmente con el botón del checkout. ' +
      'Para producción define APP_BASE_URL con tu dominio HTTPS real, ' +
      'o usa ngrok/localtunnel mientras pruebas.'
    );
  }

  const body = {
    items: itemsSeguros.map((item) => ({
      ...item,
      // COP no admite decimales: garantizamos enteros en montos y cantidades
      unit_price: Math.round(Number(item.unit_price)),
      quantity: Math.round(Number(item.quantity)),
    })),

    // Datos reales del comprador. Sin "payer", Checkout Pro abre el flujo
    // de invitado y en sandbox puede quedarse sin métodos de pago cargados
    // (botón "Pagar" deshabilitado). Aquí el cliente de Firestore es el buyer.
    payer: {
      name: String(cliente.nombre || '').split(' ')[0] || 'Cliente',
      surname:
        String(cliente.nombre || '').split(' ').slice(1).join(' ') || 'Cliente',
      email: cliente.email,
      phone: {
        area_code: '57',
        number: String(cliente.telefono || '').replace(/\D/g, ''),
      },
      address: {
        street_name: cliente.direccion || '',
      },
    },

    // NO excluir medios de pago: listas vacías = saldo, tarjetas, efectivo y
    // transferencias disponibles. NUNCA usar "purpose": "wallet_purchase",
    // deja solo la billetera y apaga el botón cuando no hay saldo.
    payment_methods: {
      excluded_payment_methods: [],
      excluded_payment_types: [],
      installments: 12,
    },

    external_reference: orderId,
    statement_descriptor: 'MI TIENDA ONLINE',
    back_urls,
    // auto_return SOLO se envía si back_urls.success es una URL pública
    // HTTPS. Con localhost, Mercado Pago la rechaza con
    // "auto_return invalid. back_url.success must be defined".
    ...(puedeUsarAutoReturn ? { auto_return: 'approved' } : {}),
    binary_mode: true,
    // Webhook de confirmación de pago (requiere HTTPS pública en producción)
    ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    metadata: { orderId },
  };

  console.log(`🔍 Creando preferencia para la orden ${orderId}:`, {
    auto_return: body.auto_return || '(omitido - URL no pública)',
    back_urls,
  });

  const response = await preferenceClient.create({ body });

  if (!response.init_point) {
    const error = new Error('Mercado Pago no devolvió una URL de pago');
    error.status = 502;
    throw error;
  }

  return {
    init_point: response.init_point,
    preferenceId: response.id,
    orderId,
    totalAmount,
  };
}

// ---------- 7. Endpoints ----------
app.get('/api/estado', (req, res) => {
  res.json({ mensaje: 'El servidor backend está funcionando correctamente 🚀' });
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { items, cliente } = req.body;

    // 1. Validamos los ítems y precios contra Firestore
    const { itemsSeguros, totalAmount } = await validarYCalcularItems(items);

    // 2. Validamos los datos del cliente
    const clienteValidado = validarCliente(cliente);

    // 3. Guardamos la orden en Firestore con estado "Pendiente"
    const orderId = await guardarOrden(clienteValidado, itemsSeguros, totalAmount);

// 4. Creamos la preferencia en Mercado Pago
    const resultado = await crearPreferencia(itemsSeguros, totalAmount, orderId, clienteValidado);

    // 5. Respondemos al frontend con el link de pago.
    //    NOTA: el correo de comprobante ya NO se envía aquí. La orden queda
    //    "Pendiente" y el correo se dispara solo desde /api/webhook cuando el
    //    pago ha sido verificado y aprobado por Mercado Pago.
    res.json(resultado);

  } catch (error) {
    console.error('Error en el checkout:', error.message || error);
    const status = error.status || 500;
    res
      .status(status)
      .json({ error: status === 500 ? 'Error interno del servidor' : error.message });
  }
});

// ---------- 7.2 Webhook (IPN) de Mercado Pago ----------
// Recibe las notificaciones de Mercado Pago, valida el pago contra la API
// real (evita notificaciones falsas) y actualiza la orden en Firestore.
app.post('/api/webhook', async (req, res) => {
  // Responder 200 OK inmediatamente: Mercado Pago reintenta la notificación
  // si no recibe un HTTP 2xx. El procesamiento sigue en segundo plano.
  res.status(200).send('OK');

  try {
    // El id del pago puede llegar por query string (?data.id=123) o dentro
    // del body ({ "data": { "id": 123 } }). Soportamos ambas formas.
    const paymentId =
      (typeof req.query['data.id'] === 'string' ? req.query['data.id'] : null) ||
      (req.body && req.body.data && req.body.data.id) ||
      (req.body && typeof req.body.id === 'number' ? req.body.id : null);

    if (!paymentId) {
      console.warn(
        'Webhook recibido sin id de pago. Query:',
        req.originalUrl,
        '| Body:',
        JSON.stringify(req.body)
      );
      return;
    }

    // 1) Consultamos el pago REAL en Mercado Pago (fuente de la verdad).
    //    Solo si este llamado devuelve datos, la notificación es legítima.
    const pago = await paymentClient.get({ id: paymentId });

    if (!pago || !pago.id) {
      console.warn('Webhook: Mercado Pago no devolvió el pago', paymentId);
      return;
    }
    // --- CHIVATOS DE DEBUGEO ---
    console.log('🔍 Datos reales devueltos por Mercado Pago:', {
      id: pago.id,
      status: pago.status,
      collector_id: pago.collector_id,
      live_mode: pago.live_mode,
      external_reference: pago.external_reference,
      transaction_amount: pago.transaction_amount
    });

    console.log('🔍 Variables de entorno actuales:', {
      MP_COLLECTOR_ID: process.env.MP_COLLECTOR_ID,
      NODE_ENV: process.env.NODE_ENV
    });

    // --- Validación estricta de identidad (riesgo medio de la auditoría) ---
    // 1) El pago debe pertenecer EXACTAMENTE a la cuenta receptora configurada.
    const collectorId = Number(process.env.MP_COLLECTOR_ID);
    if (!Number.isFinite(collectorId)) {
      console.warn(
        'Webhook ignorado: falta o es inválido process.env.MP_COLLECTOR_ID. ' +
        'Defínelo con tu user_id de Mercado Pago para autorizar notificaciones.'
      );
      return;
    }
    if (Number(pago.collector_id) !== collectorId) {
      console.warn(
        `Webhook ignorado: collector_id no coincide. Esperado=${collectorId}, recibido=${pago.collector_id}`
      );
      return;
    }

    // 2) El entorno (live_mode) debe coincidir con NODE_ENV: en 'production'
    //    solo se procesan pagos reales (live_mode=true); en cualquier otro
    //    entorno solo pagos de sandbox (live_mode=false).
    const esProduccion = process.env.NODE_ENV === 'production';
    if (Boolean(pago.live_mode) !== esProduccion) {
      console.warn(
        `Webhook ignorado: live_mode no coincide con NODE_ENV. live_mode=${pago.live_mode}, NODE_ENV=${process.env.NODE_ENV || '(no definido)'}`
      );
      return;
    }

    // 2) Extraemos el orderId desde external_reference (el encadenado al
    //    guardar la orden: preference.external_reference = orderId).
    const externalReference = pago.external_reference;

    console.log(
      `🔍 Webhook: pago ${pago.id} | estado="${pago.status}" | orderId=${externalReference}`
    );

    // Solo aprobamos cuando el pago validado está "approved".
    if (pago.status !== 'approved' || !externalReference) {
      return;
    }

    const ordenRef = db.collection('ordenes').doc(externalReference);
    const ordenSnap = await ordenRef.get();

    if (!ordenSnap.exists) {
      console.warn('Webhook: la orden no existe en Firestore', externalReference);
      return;
    }

    const orden = ordenSnap.data();

    // 3) Blindaje extra: el monto pagado debe coincidir con el total guardado.
    if (
      typeof pago.transaction_amount === 'number' &&
      typeof orden.total === 'number' &&
      Math.abs(pago.transaction_amount - orden.total) > 0.01
    ) {
      console.error(
        'Webhook: discrepancia de monto. order=',
        externalReference,
        'pago=',
        pago.transaction_amount,
        'orden=',
        orden.total
      );
      return;
    }

    // 4) Idempotencia: no reprocesar órdenes que ya fueron aprobadas.
    if (orden.estado === 'Aprobada') {
      return;
    }

    // 5) Actualización del estado de la orden en Firestore.
    await ordenRef.update({
      estado: 'Aprobada',
      idMercadoPago: String(pago.id),
      fechaAprobacion: FieldValue.serverTimestamp(),
    });

    console.log(`✅ Webhook: orden ${externalReference} marcada como Aprobada`);

    // 6) (Opción recomendada) Enviar el comprobante al cliente en el momento
    //    en que el pago es confirmado por Mercado Pago.
    try {
      await enviarCorreoComprobante(
        orden.cliente,
        orden.items || [],
        orden.total,
        externalReference
      );
      console.log("Correo enviado con exito!!")
    } catch (mailError) {
      console.error('Webhook: error enviando el correo:', mailError.message || mailError);
    }
  } catch (error) {
    console.error('Webhook: error inesperado:', error.message || error);
  }
});

// ---------- 8. Arranque ----------
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});