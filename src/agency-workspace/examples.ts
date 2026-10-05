import type {PublisherAccount} from '../shared/types';
export const examplePublishers = ['Example Publisher','Example News','Example Media'].map((name,index)=>({
  id:['example-publisher','example-news','example-media'][index],name,status:'active',notes:null,createdAt:'test-example-v1',updatedAt:'test-example-v1',sitesCount:index===0?2:1,
  sites:Array.from({length:index===0?2:1},(_,i)=>({id:`example-site-${index}-${i}`,publisherAccountId:['example-publisher','example-news','example-media'][index],name:`site${index+1}${i+1}.example.com`,domain:`site${index+1}${i+1}.example.com`,gamPath:'/123456/example.com/',status:'draft',currentReleaseId:null,currentVersion:'draft',lastPublishedAt:null,adsTxtUrl:null,createdAt:'test-example-v1',updatedAt:'test-example-v1',adUnitsCount:0,biddersCount:0,releasesCount:0})),
})) as PublisherAccount[];
