const string = {type:'string'};
const time = {type:'string',format:'date-time'};
export const CHALLENGE_SCHEMA = {
 type:'object',required:['challengeId','challengeToken','purpose','state','serverTime','expiresAt','resendAvailableAt','maskedEmail'],additionalProperties:false,
 properties:{challengeId:{type:'string',format:'uuid'},challengeToken:{type:'string',writeOnly:true},purpose:{type:'string',enum:['REGISTER','RESET','CHANGE_PASSWORD','VERIFY_EMAIL','LEGACY_EMAIL','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW']},
  state:{type:'string',enum:['preparing']},serverTime:time,expiresAt:{...time,nullable:true},resendAvailableAt:time,maskedEmail:string},
};
const {challengeToken, ...statusProperties} = CHALLENGE_SCHEMA.properties;
export const STATUS_SCHEMA = {type:'object',required:['challengeId','purpose','state','serverTime','issuedAt','expiresAt','resendAvailableAt','maskedEmail'],additionalProperties:false,
 properties:{...statusProperties,state:{type:'string',enum:['preparing','ready','expired','failed','locked','verified','consumed']},issuedAt:{...time,nullable:true}}};
export const SESSION_SCHEMA = {type:'object',required:['accessToken','refreshToken','expiresIn','refreshExpiresIn','user'],additionalProperties:false,
 properties:{accessToken:{...string,writeOnly:true},refreshToken:{...string,writeOnly:true},expiresIn:{type:'integer'},refreshExpiresIn:{type:'integer'},
 user:{type:'object',required:['id','email','phone','displayName','status'],additionalProperties:false,properties:{id:{...string,format:'uuid'},email:{...string,format:'email'},phone:{...string,nullable:true},displayName:string,status:{type:'string',enum:['ACTIVE']}}}}};
export const TICKET_SCHEMA = {type:'object',required:['ticket','ticketExpiresAt'],additionalProperties:false,properties:{ticket:{...string,writeOnly:true},ticketExpiresAt:time}};
export const REAUTH_SCHEMA = {type:'object',required:['ok','reauthenticationRequired'],additionalProperties:false,properties:{ok:{type:'boolean',enum:[true]},reauthenticationRequired:{type:'boolean',enum:[true]}}};
