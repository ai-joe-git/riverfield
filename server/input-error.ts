export type InputIssue={code:string;field:string;message:string};
export class InputError extends Error{
 readonly issues:InputIssue[];
 constructor(message:string,issues?:InputIssue[]){super(message);this.issues=issues||[{code:"INVALID_INPUT",field:/^(\w+):/.exec(message)?.[1]||"inputs",message}];}
}
export function inputErrorBody(error:InputError){return {error:error.message,status:400,code:"INPUT_VALIDATION",issues:error.issues,retryable:false};}
