import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/api-error.filter';
import { environment } from './config/env';
import { isIP } from 'node:net';
import { requestContext, withRequestContext } from './common/request-context';

async function bootstrap(): Promise<void> {
  const config = environment();
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.enableShutdownHooks();
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  if (config.trustedProxyIp) {
    if (!isIP(config.trustedProxyIp)) throw new Error('TRUSTED_PROXY_IP must be one exact proxy IP');
    express.set('trust proxy', config.trustedProxyIp);
  }
  app.setGlobalPrefix('v1');
  app.use((_request: unknown, response: {setHeader:(name:string,value:string)=>void}, next:()=>void) => withRequestContext(()=>{
    response.setHeader('X-HomeMind-Request-Id',requestContext.getStore()!.id);
    next();
  }));
  // Ghi thời gian xử lý từng request (tắt bằng REQUEST_LOG=off) để dễ thấy chỗ chậm.
  if (process.env.REQUEST_LOG !== 'off') {
    app.use((request: { method: string; route?: { path: string } }, response: { statusCode: number; on: (event: string, cb: () => void) => void }, next: () => void) => {
      const started = performance.now();
      const context=requestContext.getStore();
      response.on('finish', () => {
        const ms = performance.now() - started;
        console.log(JSON.stringify({ event: 'http', method: request.method,
          route: request.route?.path ?? 'unmatched', status: response.statusCode, durationMs: Math.round(ms),
          requestId:context?.id,...(context?.traced?{sqlProfile:true}:{}) }));
      });
      next();
    });
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ApiErrorFilter());
  if (!config.production) {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('HomeMind API')
    .setDescription('API pilot HomeMind. Dùng HomeMind access token cho tất cả route nghiệp vụ; các thao tác ghi thủ công cần Idempotency-Key.')
    .setVersion('1.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'HomeMind access token' })
    .addTag('me', 'Hồ sơ và household mặc định')
    .addTag('home', 'Tổng quan và cảnh báo hạn dùng')
    .addTag('inventory', 'Kho sản phẩm và lô')
    .addTag('shopping', 'Danh sách mua sắm')
    .addTag('assistant', 'AI read, draft, confirm và cancel')
    .build());
    // Privileged admin contracts are distributed offline, never via public Try it out.
    for (const path of Object.keys(document.paths)) {
      if (path.startsWith('/v1/admin/')) delete document.paths[path];
    }
    document.tags = document.tags?.filter(tag => !tag.name.startsWith('admin'));
  SwaggerModule.setup('v1/docs', app, document, { jsonDocumentUrl: 'v1/openapi.json', customSiteTitle: 'HomeMind API · Swagger' });
  }
  await app.listen(config.port, config.host);
}
void bootstrap();
