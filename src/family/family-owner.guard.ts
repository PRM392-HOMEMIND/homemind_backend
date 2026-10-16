import { BadRequestException,CanActivate,ExecutionContext,Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { FamilyService } from './family.service';
import { AuthRequest } from '../auth/auth.guard';
@Injectable()
export class FamilyOwnerGuard implements CanActivate {
 constructor(private readonly family:FamilyService){}
 async canActivate(context:ExecutionContext){
  const request=context.switchToHttp().getRequest<AuthRequest>();
  const workspace=request.params.id;
  if(typeof workspace!=='string'||!isUUID(workspace))throw new BadRequestException('Workspace không hợp lệ.');
  await this.family.assertOwner(request.userId,workspace);return true;
 }
}
